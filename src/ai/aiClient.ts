/**
 * AI 客户端（M5-2 / M5-3 前端侧）：把 provider 纯逻辑 + Rust 流式命令 + Tauri 事件
 * 粘合起来，并实现「工具调用」的 agentic 循环。
 *
 * 传输：buildChatRequest 构造 url/headers/body → invoke('ai_chat_stream') → 监听
 * ai://chunk 事件，用 parseSseChunkRich 增量解析出内容 / 工具调用 / finish_reason。
 * 非 Tauri（浏览器预览）用 fetch + ReadableStream 回退。
 *
 * 工具循环（M5-3）：若模型 finish_reason='tool_calls'，则本地执行工具、把结果作为
 * tool 消息回填，再发起下一轮，直到得到普通回答或达到最大轮数。
 */

import {
  buildChatRequest,
  parseSseChunkRich,
  accumulateToolCalls,
  type ChatMessage,
  type ToolCall,
  type ToolCallDelta,
} from './provider';
import type { AiSettings } from './aiSettings';
import { TOOL_DEFS, executeTool, type ToolContext } from './tools';

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** 工具调用开始时的通知（用于 UI 显示"正在查阅…"），可选 */
  onToolStart?: (name: string) => void;
}

export interface StreamHandle {
  cancel: () => void;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function newRequestId(): string {
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

interface HttpSpec {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 一轮请求的累积结果 */
interface RoundResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  error?: string;
  cancelled?: boolean;
}

interface RoundCallbacks {
  onContent: (text: string) => void;
}

/** 可取消令牌 */
interface CancelToken {
  cancelled: boolean;
  /** 当前进行中一轮的取消函数 */
  cancelCurrent?: () => void;
}

function specFor(settings: AiSettings, messages: ChatMessage[], useTools: boolean): HttpSpec {
  return buildChatRequest(
    {
      kind: settings.kind,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
    },
    messages,
    useTools ? TOOL_DEFS : undefined,
  );
}

/** 运行一轮请求（Tauri 事件版），流式回调内容，Promise 收敛完整结果。 */
function runRoundTauri(spec: HttpSpec, cb: RoundCallbacks, token: CancelToken): Promise<RoundResult> {
  return new Promise((resolve) => {
    const requestId = newRequestId();
    let buffer = '';
    let content = '';
    const toolDeltas: ToolCallDelta[] = [];
    let finishReason: string | null = null;
    let settled = false;
    const unlisten: Array<() => void> = [];

    const cleanup = () => {
      for (const u of unlisten) {
        try {
          u();
        } catch {
          /* noop */
        }
      }
    };

    const finish = (extra?: Partial<RoundResult>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        content,
        toolCalls: accumulateToolCalls(toolDeltas),
        finishReason,
        ...extra,
      });
    };

    token.cancelCurrent = () => {
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('ai_cancel', { requestId }))
        .catch(() => {});
      finish({ cancelled: true });
    };

    (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');

      const handleData = (data: string) => {
        buffer += data;
        const r = parseSseChunkRich(buffer);
        buffer = r.rest;
        for (const d of r.contentDeltas) {
          content += d;
          cb.onContent(d);
        }
        for (const t of r.toolCallDeltas) toolDeltas.push(t);
        if (r.finishReason) finishReason = r.finishReason;
      };

      unlisten.push(
        await listen<{ requestId: string; data: string }>('ai://chunk', (e) => {
          if (e.payload.requestId !== requestId || settled) return;
          handleData(e.payload.data);
        }),
      );
      unlisten.push(
        await listen<{ requestId: string }>('ai://done', (e) => {
          if (e.payload.requestId !== requestId) return;
          finish();
        }),
      );
      unlisten.push(
        await listen<{ requestId: string; message: string }>('ai://error', (e) => {
          if (e.payload.requestId !== requestId) return;
          finish({ error: e.payload.message });
        }),
      );

      try {
        await invoke('ai_chat_stream', {
          requestId,
          url: spec.url,
          headers: spec.headers,
          body: spec.body,
        });
      } catch (err) {
        finish({ error: String(err) });
      }
    })();
  });
}

/** 运行一轮请求（浏览器 fetch 版）。 */
function runRoundFetch(spec: HttpSpec, cb: RoundCallbacks, token: CancelToken): Promise<RoundResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let content = '';
    const toolDeltas: ToolCallDelta[] = [];
    let finishReason: string | null = null;
    let settled = false;

    const finish = (extra?: Partial<RoundResult>) => {
      if (settled) return;
      settled = true;
      resolve({ content, toolCalls: accumulateToolCalls(toolDeltas), finishReason, ...extra });
    };

    token.cancelCurrent = () => {
      controller.abort();
      finish({ cancelled: true });
    };

    (async () => {
      try {
        const resp = await fetch(spec.url, {
          method: 'POST',
          headers: spec.headers,
          body: spec.body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }
        const reader = resp.body?.getReader();
        if (!reader) throw new Error('无响应流');
        const decoder = new TextDecoder();
        let buffer = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const r = parseSseChunkRich(buffer);
          buffer = r.rest;
          for (const d of r.contentDeltas) {
            content += d;
            cb.onContent(d);
          }
          for (const t of r.toolCallDeltas) toolDeltas.push(t);
          if (r.finishReason) finishReason = r.finishReason;
          if (r.done) break;
        }
        finish();
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') finish({ cancelled: true });
        else finish({ error: String(err) });
      }
    })();
  });
}

const runRound = (spec: HttpSpec, cb: RoundCallbacks, token: CancelToken) =>
  inTauri() ? runRoundTauri(spec, cb, token) : runRoundFetch(spec, cb, token);

const MAX_TOOL_ROUNDS = 5;

/**
 * 带工具循环的对话（M5-3）。传入 toolCtx 则启用白板工具。
 */
export function streamChatAgentic(
  settings: AiSettings,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  toolCtx?: ToolContext,
): StreamHandle {
  const token: CancelToken = { cancelled: false };
  const useTools = !!toolCtx;

  (async () => {
    const convo = messages.slice();
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (token.cancelled) break;
        const spec = specFor(settings, convo, useTools);
        const result = await runRound(spec, { onContent: handlers.onDelta }, token);

        if (result.cancelled || token.cancelled) {
          handlers.onDone();
          return;
        }
        if (result.error) {
          handlers.onError(result.error);
          return;
        }

        // 需要调用工具
        if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0 && toolCtx) {
          // 记录 assistant 的工具调用意图
          convo.push({
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls,
          });
          for (const call of result.toolCalls) {
            if (token.cancelled) break;
            handlers.onToolStart?.(call.function.name);
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              args = {};
            }
            const output = await executeTool(call.function.name, args, toolCtx);
            convo.push({ role: 'tool', tool_call_id: call.id, content: output });
          }
          continue; // 进入下一轮，让模型基于工具结果作答
        }

        // 普通回答，结束
        handlers.onDone();
        return;
      }
      // 超过最大轮数
      handlers.onDone();
    } catch (err) {
      handlers.onError(String(err));
    }
  })();

  return {
    cancel: () => {
      token.cancelled = true;
      token.cancelCurrent?.();
    },
  };
}

/** 无工具的简单流式对话（保留给不需要白板上下文的场景）。 */
export function streamChat(
  settings: AiSettings,
  messages: ChatMessage[],
  handlers: StreamHandlers,
): StreamHandle {
  return streamChatAgentic(settings, messages, handlers);
}
