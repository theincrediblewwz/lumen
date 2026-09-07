/**
 * AI 客户端（M5-2 前端侧）：把 provider 纯逻辑 + Rust 流式命令 + Tauri 事件粘合起来。
 *
 * 流程：buildChatRequest 构造 url/headers/body → invoke('ai_chat_stream') → 监听
 * ai://chunk 事件，用 parseSseChunk 增量解析出文本 → onDelta 回调；ai://done/error
 * 收敛。支持取消（invoke('ai_cancel')）。
 *
 * 非 Tauri 环境（浏览器预览）用 fetch + ReadableStream 回退，方便开发预览。
 */

import { buildChatRequest, parseSseChunk, type ChatMessage } from './provider';
import type { AiSettings } from './aiSettings';

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface StreamHandle {
  /** 取消当前流 */
  cancel: () => void;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function newRequestId(): string {
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function streamChat(
  settings: AiSettings,
  messages: ChatMessage[],
  handlers: StreamHandlers,
): StreamHandle {
  const spec = buildChatRequest(
    {
      kind: settings.kind,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
    },
    messages,
  );

  if (inTauri()) {
    return streamViaTauri(spec, handlers);
  }
  return streamViaFetch(spec, handlers);
}

function streamViaTauri(
  spec: { url: string; headers: Record<string, string>; body: string },
  handlers: StreamHandlers,
): StreamHandle {
  const requestId = newRequestId();
  let buffer = '';
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

  (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const onChunk = await listen<{ requestId: string; data: string }>(
      'ai://chunk',
      (e) => {
        if (e.payload.requestId !== requestId || settled) return;
        buffer += e.payload.data;
        const { deltas, done, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const d of deltas) handlers.onDelta(d);
        if (done && !settled) {
          settled = true;
          handlers.onDone();
          cleanup();
        }
      },
    );
    unlisten.push(onChunk);

    const onDone = await listen<{ requestId: string }>('ai://done', (e) => {
      if (e.payload.requestId !== requestId || settled) return;
      settled = true;
      handlers.onDone();
      cleanup();
    });
    unlisten.push(onDone);

    const onError = await listen<{ requestId: string; message: string }>(
      'ai://error',
      (e) => {
        if (e.payload.requestId !== requestId || settled) return;
        settled = true;
        handlers.onError(e.payload.message);
        cleanup();
      },
    );
    unlisten.push(onError);

    try {
      await invoke('ai_chat_stream', {
        requestId,
        url: spec.url,
        headers: spec.headers,
        body: spec.body,
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        handlers.onError(String(err));
        cleanup();
      }
    }
  })();

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('ai_cancel', { requestId }))
        .catch(() => {});
    },
  };
}

function streamViaFetch(
  spec: { url: string; headers: Record<string, string>; body: string },
  handlers: StreamHandlers,
): StreamHandle {
  const controller = new AbortController();
  let settled = false;

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
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const d of parsed.deltas) handlers.onDelta(d);
        if (parsed.done) break;
      }
      if (!settled) {
        settled = true;
        handlers.onDone();
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        if ((err as Error)?.name === 'AbortError') handlers.onDone();
        else handlers.onError(String(err));
      }
    }
  })();

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      controller.abort();
    },
  };
}
