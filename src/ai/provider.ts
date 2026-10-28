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

import { modelLimits, modelPreset, modelTemperature, reasoningFields, PROTOCOL_RESERVE, type ModelPreset } from './modelCatalog';
import { estimateTokens } from './boardContext';
export type ProviderKind = 'openai' | 'anthropic' | 'ollama';

/** OpenAI 兼容的工具调用（function calling）片段 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 发起的工具调用 */
  tool_calls?: ToolCall[];
  /** tool 角色回执对应的调用 id */
  tool_call_id?: string;
  /** Retained only within a tool round; never shown as the user's own understanding. */
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
}

export interface ChatRequestConfig {
  kind: ProviderKind;
  /** 形如 https://api.openai.com/v1（不含结尾斜杠亦可） */
  baseUrl: string;
  endpointMode?: 'base' | 'legacy';
  apiKey: string;
  model: string;
  /** 0–2，默认 0.7 */
  temperature?: number;
  /** 可选：最大生成 token */
  maxTokens?: number | null;
  contextBudget?: number;
  reasoningEffort?: string;
  /** Frozen at task start; catalogue updates cannot change a tool loop midway. */
  policy?: ModelPreset | null;
  sessionId?: string;
  toolChoice?: 'auto'|'none';
}

/** 供 Rust 传输层使用的完整请求描述（URL + headers + body 字符串） */
export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 去掉结尾斜杠，拼出 chat completions 端点 */
export function chatCompletionsUrl(baseUrl: string, mode: 'base'|'legacy' = 'base'): string {
  const url = new URL(baseUrl.trim());
  const path = url.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(path)) {
    const prefix = path && mode==='legacy' && !/\/v\d+$/.test(path) ? `${path}/v1` : path;
    url.pathname = `${prefix || (url.hostname === 'api.deepseek.com' ? '' : '/v1')}/chat/completions`;
  } else url.pathname = path;
  url.hash = '';
  return url.toString();
}

export function requestInputTokens(messages:ChatMessage[],tools?:unknown[]):number {
  return estimateTokens(JSON.stringify(messages))+(tools?.length?estimateTokens(JSON.stringify(tools)):0);
}

/** 构造 OpenAI 兼容的流式请求（URL + headers + JSON body） */
export function buildChatRequest(
  cfg: ChatRequestConfig,
  messages: ChatMessage[],
  tools?: unknown[],
): HttpRequestSpec {
  if (cfg.kind !== 'openai') {
    throw new Error(`暂不支持的 provider: ${cfg.kind}（当前仅 openai 兼容）`);
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
  };
  const preset = cfg.policy === undefined ? modelPreset(cfg.model, cfg.baseUrl) : cfg.policy ?? undefined;
  const limits = modelLimits(cfg.model, cfg.maxTokens ?? undefined, cfg.baseUrl, preset ?? null);
  if (!preset?.omitTemperature) body.temperature = modelTemperature(cfg.model, preset?.temperature ?? cfg.temperature, preset ?? null);
  Object.assign(body, preset?.extra);
  Object.assign(body, reasoningFields(preset, cfg.reasoningEffort));
  if (tools && tools.length > 0) {
    if (/^gpt-(6-astra|6\.1-sol)(-|$)/.test(cfg.model)) throw new Error('这个型号的白板工具需要 Responses API；请先选 GPT-6 Luna 或 Sol。');
    if (/^gpt-6-(sol|luna)(-|$)/.test(cfg.model) && body.reasoning_effort !== 'none') throw new Error('此型号在当前 Chat 白板工具中仅支持关闭思考；高思考工具需 Responses 协议。');
    body.tools = tools;
    body.tool_choice = cfg.toolChoice??'auto';
  }
  const input = requestInputTokens(messages,tools);
  if (input > limits.maxInput || (cfg.contextBudget != null && input > cfg.contextBudget)) throw new Error('实际请求资料超过输入预算，请调整预算或缩短资料。');
  const remaining = Math.floor(limits.window - input - PROTOCOL_RESERVE);
  if (remaining < 1) throw new Error('模型窗口没有剩余输出空间，请缩短资料。');
  if (cfg.maxTokens != null || preset) body[preset?.outputParameter ?? 'max_tokens'] = Math.min(limits.output, remaining);
  if (cfg.contextBudget != null && (!Number.isFinite(cfg.contextBudget) || cfg.contextBudget > limits.maxInput || cfg.contextBudget < 1000)) throw new Error('上下文预算超出当前模型可用范围');

  return {
    url: chatCompletionsUrl(cfg.baseUrl,cfg.endpointMode),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(new URL(cfg.baseUrl).hostname === 'opencode.ai' ? { 'User-Agent': 'Lumen/0.1.8', 'x-opencode-session': cfg.sessionId ?? 'lumen-connection-test' } : {}),
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

// SSE accepts LF, CRLF and CR. Keep a trailing CR until the next chunk so a
// split CRLF cannot accidentally turn into two newlines (a premature event).
function normalizeSseLines(buffer:string):string {
  const pending=buffer.endsWith('\r');
  return (pending?buffer.slice(0,-1):buffer).replace(/\r\n|\r/g,'\n')+(pending?'\r':'');
}

export function parseSseChunk(buffer: string): SseParseResult {
  buffer=normalizeSseLines(buffer);
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

/** 工具调用的流式增量（可能只带部分字段） */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** arguments 的片段（需按 index 累加拼接） */
  argsFragment?: string;
}

export interface SseRichResult {
  error?:string;
  reasoningDetails: Record<string, unknown>[];
  contentDeltas: string[];
  reasoningDeltas: string[];
  toolCallDeltas: ToolCallDelta[];
  /** 收到的 finish_reason（如 'stop' / 'tool_calls'） */
  finishReason: string | null;
  done: boolean;
  rest: string;
}

/**
 * 增强版 SSE 解析：同时抽取 content 增量、tool_calls 增量与 finish_reason。
 * 与 parseSseChunk 一样是纯函数、维护 rest。
 */
export function parseSseChunkRich(buffer: string): SseRichResult {
  buffer=normalizeSseLines(buffer);
  const reasoningDetails: Record<string, unknown>[] = [];
  const contentDeltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const toolCallDeltas: ToolCallDelta[] = [];
  let finishReason: string | null = null;
  let done = false;
  let error:string|undefined;

  const lastSep = buffer.lastIndexOf('\n\n');
  if (lastSep === -1) {
    return { contentDeltas, reasoningDeltas, reasoningDetails, toolCallDeltas, finishReason, done, rest: buffer };
  }
  const complete = buffer.slice(0, lastSep);
  const rest = buffer.slice(lastSep + 2);

  for (const rawEvent of complete.split('\n\n')) {
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
      if(json?.error){error=String(json.error.message??json.error).slice(0,500);break;}
      const choice = json?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === 'string') reasoningDeltas.push(delta.reasoning_content);
      else if (typeof delta?.reasoning === 'string') reasoningDeltas.push(delta.reasoning);
      if (Array.isArray(delta?.reasoning_details)) for (const detail of delta.reasoning_details) if (detail && typeof detail === 'object') reasoningDetails.push(detail);
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        contentDeltas.push(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          toolCallDeltas.push({
            index: typeof tc.index === 'number' ? tc.index : 0,
            id: tc.id,
            name: tc.function?.name,
            argsFragment: tc.function?.arguments,
          });
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    } catch {
      /* 忽略半个 JSON */
    }
  }
  return { contentDeltas, reasoningDeltas, reasoningDetails, toolCallDeltas, finishReason, done, rest,...(error?{error}:{}) };
}

export function accumulateReasoningDetails(deltas: Record<string,unknown>[]): Record<string,unknown>[] {
  const merged: Record<string,unknown>[] = [];
  for (const delta of deltas) {
    const existing = typeof delta.index === 'number' ? merged.find(d => d.index === delta.index && d.type === delta.type) : undefined;
    if (!existing) { merged.push({ ...delta }); continue; }
    for (const [key,value] of Object.entries(delta)) {
      existing[key] = ['text','data','signature'].includes(key) && typeof value === 'string' && typeof existing[key] === 'string' ? existing[key] + value : value;
    }
  }
  return merged;
}

/** 把一串 tool_call 增量按 index 合并成完整的 ToolCall[]。 */
export function accumulateToolCalls(deltas: ToolCallDelta[]): ToolCall[] {
  const byIndex = new Map<number, ToolCall>();
  for (const d of deltas) {
    let tc = byIndex.get(d.index);
    if (!tc) {
      tc = { id: '', type: 'function', function: { name: '', arguments: '' } };
      byIndex.set(d.index, tc);
    }
    if (d.id) tc.id = d.id;
    if (d.name) tc.function.name = d.name;
    if (d.argsFragment) tc.function.arguments += d.argsFragment;
  }
  return Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc);
}
