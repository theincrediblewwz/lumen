/**
 * AI Provider 纯逻辑层（M5-2）
 *
 * 只负责「构造请求」与「解析流式响应」的纯函数，不做任何网络 I/O——
 * 真正的传输走 Rust 侧命令 `ai_chat_stream`（reqwest 流式 + 事件回传），
 * 以守住 DESIGN 的「前端零网络能力」安全边界。把纯逻辑抽出来便于单测。
 *
 * 目前实现 OpenAI 兼容协议（/v1/chat/completions，SSE 流）。Provider 抽象保留
 * kind 字段，后续可扩展 anthropic / ollama（O-3 定案：OpenAI 兼容优先）。
 */

export type ProviderKind = 'openai' | 'anthropic' | 'ollama';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestConfig {
  kind: ProviderKind;
  /** 形如 https://api.openai.com/v1（不含结尾斜杠亦可） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0–2，默认 0.7 */
  temperature?: number;
  /** 可选：最大生成 token */
  maxTokens?: number | null;
}

/** 供 Rust 传输层使用的完整请求描述（URL + headers + body 字符串） */
export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 去掉结尾斜杠，拼出 chat completions 端点 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  // 允许用户填到 /v1 或直接填全路径；若已含 chat/completions 则原样用
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** 构造 OpenAI 兼容的流式请求（URL + headers + JSON body） */
export function buildChatRequest(
  cfg: ChatRequestConfig,
  messages: ChatMessage[],
): HttpRequestSpec {
  if (cfg.kind !== 'openai') {
    throw new Error(`暂不支持的 provider: ${cfg.kind}（当前仅 openai 兼容）`);
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature ?? 0.7,
  };
  if (cfg.maxTokens != null) body.max_tokens = cfg.maxTokens;

  return {
    url: chatCompletionsUrl(cfg.baseUrl),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

/**
 * 增量解析 SSE 文本缓冲区。传入「至今累积的原始文本」，返回：
 *  - deltas：本次能完整解析出的所有内容增量（按顺序）
 *  - done：是否收到 [DONE] 终止标记
 *  - rest：尚未构成完整事件、需保留到下次的剩余文本
 *
 * 设计为纯函数：调用方维护 buffer = rest + 新到 chunk，反复调用。
 */
export interface SseParseResult {
  deltas: string[];
  done: boolean;
  rest: string;
}

export function parseSseChunk(buffer: string): SseParseResult {
  const deltas: string[] = [];
  let done = false;

  // SSE 事件以空行（\n\n）分隔；不完整的尾部留到下次
  const lastSep = buffer.lastIndexOf('\n\n');
  if (lastSep === -1) {
    return { deltas, done, rest: buffer };
  }
  const complete = buffer.slice(0, lastSep);
  const rest = buffer.slice(lastSep + 2);

  for (const rawEvent of complete.split('\n\n')) {
    // 一个事件可能有多行，取所有 data: 行拼起来
    const dataLines = rawEvent
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const json = JSON.parse(payload);
      const delta: string | undefined = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) deltas.push(delta);
    } catch {
      // 半个 JSON（理论上不该发生，因为按 \n\n 切分）——忽略该事件
    }
  }
  return { deltas, done, rest };
}

/** 把整段 SSE 文本一次性解析成完整回答（便于测试/非流式回退） */
export function collectSseText(fullSse: string): string {
  let buffer = fullSse.endsWith('\n\n') ? fullSse : fullSse + '\n\n';
  const { deltas } = parseSseChunk(buffer);
  return deltas.join('');
}
