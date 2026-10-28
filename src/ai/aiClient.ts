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
  accumulateReasoningDetails,
  requestInputTokens,
  type ChatMessage,
  type ToolCall,
  type ToolCallDelta,
} from './provider';
import type { AiSettings } from './aiSettings';
import { modelPreset, type ModelPreset } from './modelCatalog';
import { TOOL_DEFS, WRITE_TOOL, executeTool, type ToolContext } from './tools';
import { CONVERSATION_TOOLS } from './conversationTools';

export interface RetryNotice {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** 工具调用开始时的通知（用于 UI 显示"正在查阅…"），可选 */
  onToolStart?: (name: string) => void;
  /** Recheck permission before each provider round, including tool continuations. */
  beforeRequest?: () => Promise<void>;
  sessionId?: string;
  purpose?:'structured';
  onRoundResult?:(result:{finishReason:string|null;reasoningChars:number;contentChars:number})=>void;
  onRoundStart?: () => void;
  /** The server rejected this attempt before streaming; the transport will retry. */
  onRetry?: (notice: RetryNotice) => void;
  /** Presence only; raw model reasoning never crosses this UI callback. */
  onReasoning?: (characters:number) => void;
  onToolEnd?: () => void;
  /** Separate public-catalogue task. Never receives whiteboard tools or secrets. */
  tools?: { definitions: unknown[]; execute: (name: string, args: Record<string, unknown>) => Promise<unknown> };
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
  terminated?:boolean;
  content: string;
  reasoning?: string;
  reasoningDetails?: Record<string,unknown>[];
  toolCalls: ToolCall[];
  finishReason: string | null;
  error?: string;
  cancelled?: boolean;
}

interface RoundCallbacks {
  onContent: (text: string) => void;
  onReasoning?: (characters:number) => void;
  onRetry?: (notice: RetryNotice) => void;
}

/** 可取消令牌 */
interface CancelToken {
  cancelled: boolean;
  /** 当前进行中一轮的取消函数 */
  cancelCurrent?: () => void;
}

function specFor(settings: AiSettings, messages: ChatMessage[], definitions: unknown[] | undefined, policy: ModelPreset | null, sessionId: string,finalRound=false): HttpSpec {
  return buildChatRequest(
    {
      kind: settings.kind,
      baseUrl: settings.baseUrl,
      endpointMode: settings.endpointMode,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      contextBudget: settings.contextBudget,
      reasoningEffort: settings.reasoningEffort,
      policy,
      sessionId,
      toolChoice:finalRound?'none':'auto',
    },
    messages,
    definitions,
  );
}

/** 运行一轮请求（Tauri 事件版），流式回调内容，Promise 收敛完整结果。 */
function runRoundTauri(spec: HttpSpec, cb: RoundCallbacks, token: CancelToken): Promise<RoundResult> {
  return new Promise((resolve) => {
    const requestId = newRequestId();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const reasoningDetails: Record<string,unknown>[] = [];
    const toolDeltas: ToolCallDelta[] = [];
    let finishReason: string | null = null;
    let terminated=false;
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
        reasoning,
        reasoningDetails: accumulateReasoningDetails(reasoningDetails),
        toolCalls: accumulateToolCalls(toolDeltas),
        finishReason,
        terminated,
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
        if(r.done||r.finishReason)terminated=true;
        buffer = r.rest;
        reasoning += r.reasoningDeltas.join('');
        reasoningDetails.push(...r.reasoningDetails);
        if (r.reasoningDeltas.length || r.reasoningDetails.length) cb.onReasoning?.(r.reasoningDeltas.reduce((n,d)=>n+d.length,0));
        for (const d of r.contentDeltas) {
          content += d;
          cb.onContent(d);
        }
        for (const t of r.toolCallDeltas) toolDeltas.push(t);
        if (r.finishReason) finishReason = r.finishReason;
        if(r.error){finish({error:r.error});return;}
      };

      const retain=(stop:()=>void)=>{if(settled||token.cancelled)stop();else unlisten.push(stop);};
      retain(
        await listen<{ requestId: string; data: string }>('ai://chunk', (e) => {
          if (e.payload.requestId !== requestId || settled) return;
          handleData(e.payload.data);
        }),
      );
      if(settled||token.cancelled)return;
      retain(
        await listen<{ requestId: string }>('ai://done', (e) => {
          if (e.payload.requestId !== requestId) return;
          // Flush a final unterminated data line only when the transport ends.
          if(buffer.trim())handleData('\n\n');
          finish();
        }),
      );
      if(settled||token.cancelled)return;
      retain(
        await listen<{ requestId: string; message: string }>('ai://error', (e) => {
          if (e.payload.requestId !== requestId) return;
          finish({ error: e.payload.message });
        }),
      );
      if(settled||token.cancelled)return;
      retain(
        await listen<RetryNotice & { requestId: string }>('ai://retry', (e) => {
          if (e.payload.requestId !== requestId || settled || token.cancelled) return;
          cb.onRetry?.(e.payload);
        }),
      );

      try {
        if (token.cancelled) { finish({ cancelled: true }); return; }
        await invoke('ai_chat_stream', {
          requestId,
          url: spec.url,
          headers: spec.headers,
          body: spec.body,
        });
      } catch (err) {
        finish({ error: String(err) });
      }
    })().catch(err=>finish({error:String(err)}));
  });
}

/** 运行一轮请求（浏览器 fetch 版）。 */
function runRoundFetch(spec: HttpSpec, cb: RoundCallbacks, token: CancelToken): Promise<RoundResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let content = '';
    let reasoning = '';
    const reasoningDetails: Record<string,unknown>[] = [];
    const toolDeltas: ToolCallDelta[] = [];
    let finishReason: string | null = null;
    let terminated=false;
    let settled = false;

    const finish = (extra?: Partial<RoundResult>) => {
      if (settled) return;
      settled = true;
      resolve({ content, reasoning, reasoningDetails: accumulateReasoningDetails(reasoningDetails), toolCalls: accumulateToolCalls(toolDeltas), finishReason,terminated, ...extra });
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
          if(r.done||r.finishReason)terminated=true;
          buffer = r.rest;
          reasoning += r.reasoningDeltas.join('');
          reasoningDetails.push(...r.reasoningDetails);
          if (r.reasoningDeltas.length || r.reasoningDetails.length) cb.onReasoning?.(r.reasoningDeltas.reduce((n,d)=>n+d.length,0));
          for (const d of r.contentDeltas) {
            content += d;
            cb.onContent(d);
          }
          for (const t of r.toolCallDeltas) toolDeltas.push(t);
          if (r.finishReason) finishReason = r.finishReason;
          if(r.error)throw new Error(r.error);
          if (r.done) break;
        }
        if(buffer.trim()){
          const tail=parseSseChunkRich(buffer+decoder.decode()+'\n\n');
          if(tail.done||tail.finishReason)terminated=true;
          reasoning+=tail.reasoningDeltas.join('');reasoningDetails.push(...tail.reasoningDetails);
          if(tail.reasoningDeltas.length||tail.reasoningDetails.length)cb.onReasoning?.(tail.reasoningDeltas.reduce((n,d)=>n+d.length,0));
          for(const d of tail.contentDeltas){content+=d;cb.onContent(d);}
          toolDeltas.push(...tail.toolCallDeltas);if(tail.finishReason)finishReason=tail.finishReason;
          if(tail.error)throw new Error(tail.error);
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
  settings = { ...settings };
  const policy = structuredClone(modelPreset(settings.model, settings.baseUrl)) ?? null;
  const sessionId = handlers.sessionId ?? newRequestId();
  const token: CancelToken = { cancelled: false };
  if(toolCtx)toolCtx.cancelled=()=>token.cancelled;
  const definitions = handlers.tools?.definitions ?? (toolCtx ? [...(toolCtx.shareBoard===false?[]:TOOL_DEFS),...(toolCtx.conversationMessages?CONVERSATION_TOOLS:[]),...(toolCtx.shareBoard!==false&&toolCtx.applyOperations?[WRITE_TOOL]:[])] : undefined);

  (async () => {
    const convo = messages.slice();
    let finishWithoutTools=false;
    try {
      const maxRounds=handlers.tools?8:MAX_TOOL_ROUNDS;
      for (let round = 0; round < maxRounds; round++) {
        if (token.cancelled) break;
        const tokens = requestInputTokens(convo,definitions);
        if (tokens > settings.contextBudget) throw new Error('对话或工具资料超过上下文预算，请增大预算或开始新对话。');
        await handlers.beforeRequest?.();
        if (token.cancelled) break;
        handlers.onRoundStart?.();
        const spec = specFor(settings, convo, definitions, policy, sessionId,finishWithoutTools||round===maxRounds-1);
        const result = await runRound(spec, { onContent: handlers.onDelta, onReasoning: handlers.onReasoning, onRetry: handlers.onRetry }, token);

        if (result.cancelled || token.cancelled) {
          handlers.onDone();
          return;
        }
        if (result.error) {
          handlers.onError(result.error);
          return;
        }

        handlers.onRoundResult?.({finishReason:result.finishReason,reasoningChars:result.reasoning?.length??0,contentChars:result.content.length});
        if(handlers.purpose==='structured'){
          if(result.finishReason==='length')throw new Error(result.content.trim()?'模型达到输出上限，树结构尚未完整生成。请提高连接的输出额度或减少本次整理范围；原文保留，白板尚未改动。':'思考已达到输出上限，尚未生成树结构正文。思考和正文共用输出额度，请提高输出上限或关闭深入分析后重试；原文保留，白板尚未改动。');
          if(!result.terminated)throw new Error('结构分析的响应流提前结束，未收到完成标记。原文保留，白板尚未改动，请重试。');
          if(result.finishReason&&result.finishReason!=='stop')throw new Error(`结构分析未正常完成（${result.finishReason}），原文保留，白板尚未改动。`);
          if(!result.content.trim())throw new Error(result.reasoning?'模型仅返回思考，未生成树结构正文。可关闭深入分析或调整输出额度后重试；原文保留，白板尚未改动。':'模型结束了响应，但未返回树结构正文。原文保留，白板尚未改动，请检查模型设置后重试。');
        }

        // 需要调用工具
        if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0 && (toolCtx || handlers.tools)) {
          if(finishWithoutTools||round===maxRounds-1)throw new Error('已达到工具轮次或资料预算上限，模型未返回最终说明；已完成的白板操作仍保留。');
          // 记录 assistant 的工具调用意图
          convo.push({
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            ...(result.reasoningDetails?.length ? { reasoning_details: result.reasoningDetails } : {}),
          });
          for (const call of result.toolCalls) {
            if (token.cancelled) break;
            handlers.onToolStart?.(call.function.name);
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              if(call.function.name==='apply_board_operations')throw new Error('AI 操作参数不是有效 JSON，本批未执行。');
              args = {};
            }
            if(!args||typeof args!=='object'||Array.isArray(args)){
              if(call.function.name==='apply_board_operations')throw new Error('AI 操作参数须为JSON对象，本批未执行。');
              args={};
            }
            if(toolCtx)toolCtx.maxDocChars=Math.max(0,settings.contextBudget-requestInputTokens(convo,definitions)-512);
            const noRoom=!!toolCtx&&toolCtx.maxDocChars!<128;
            if(noRoom)finishWithoutTools=true;
            const output = noRoom?'本轮上下文空间不足，未继续读取或操作。请根据已有资料说明已知和未完成部分。':handlers.tools ? JSON.stringify(await handlers.tools.execute(call.function.name, args)) : await executeTool(call.function.name, args, toolCtx!,call.id);
            if(output.startsWith('上下文空间不足'))finishWithoutTools=true;
            handlers.onToolEnd?.();
            convo.push({ role: 'tool', tool_call_id: call.id, content: output });
          }
          continue; // 进入下一轮，让模型基于工具结果作答
        }

        // A thinking-only/empty response must not silently appear as success.
        if(!result.content.trim())throw Error('模型未返回可见回答，问题原文已保留。请检查模型或连接后重试；已完成的白板操作仍保留。');
        // 普通回答，结束
        handlers.onDone();
        return;
      }
      // 超过最大轮数
      handlers.onDone();
    } catch (err) {
      handlers.onError(err instanceof Error?err.message:String(err));
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
