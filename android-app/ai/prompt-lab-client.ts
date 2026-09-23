import { createChatCompletionsUrl, normalizeApiKey, normalizeByokProfile, type ByokCredentials } from '@/ai/byok-profile';
import { ByokProviderError, type ByokUsage } from '@/ai/byok-client';
import {
  diagnosePromptLabOutput,
  estimateMimoCostCny,
  type PromptLabDiagnostic,
  type PromptLabPreparedRequest,
  PROMPT_LAB_BASE_URL,
  PROMPT_LAB_MODEL,
} from '@/ai/prompt-lab';

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export type PromptLabCompletion = {
  content: string;
  actualModel: string | null;
  providerResponseId: string | null;
  usage: (ByokUsage & { cachedInputTokens: number | null }) | null;
  latencyMs: number;
  estimatedCostCny: number | null;
  diagnostic: PromptLabDiagnostic;
};

export type PromptLabResponseMetadata = {
  content: string | null;
  actualModel: string | null;
  providerResponseId: string | null;
  usage: PromptLabCompletion['usage'];
  latencyMs: number;
  estimatedCostCny: number | null;
  diagnostic: PromptLabDiagnostic | null;
  finishReason: string | null;
};

export class PromptLabResponseError extends ByokProviderError {
  constructor(
    message: string,
    code: string,
    status: number | null,
    public readonly responseMetadata: PromptLabResponseMetadata,
  ) {
    super(message, code, false, status);
    this.name = 'PromptLabResponseError';
  }
}

export function assertPromptLabCredentials(credentials: ByokCredentials) {
  const profile = normalizeByokProfile(credentials.profile);
  const apiKey = normalizeApiKey(credentials.apiKey);
  if (profile.kind !== 'mimo'
    || profile.baseUrl !== PROMPT_LAB_BASE_URL
    || profile.model !== PROMPT_LAB_MODEL
    || !profile.jsonMode
    || profile.tokenLimitField !== 'max_completion_tokens') {
    throw new ByokProviderError(
      'Prompt 实验只允许 Xiaomi MiMo 官方预设：mimo-v2.5、官方 v1 地址、JSON mode 与 max_completion_tokens',
      'prompt_lab_profile_mismatch',
      false,
    );
  }
  return { profile, apiKey };
}

export function createPromptLabRequestBody(request: PromptLabPreparedRequest) {
  return {
    ...request.parameters,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    response_format: { type: 'json_object' },
  };
}

export async function requestPromptLabCompletion(
  request: PromptLabPreparedRequest,
  credentials: ByokCredentials,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PromptLabCompletion> {
  const { profile, apiKey } = assertPromptLabCredentials(credentials);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(createChatCompletionsUrl(profile.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPromptLabRequestBody(request)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const uncertain = response.status >= 500;
      throw new ByokProviderError(
        uncertain
          ? `MiMo 返回 HTTP ${response.status}，是否已计费不确定；实验已停止且不会自动重试`
          : `MiMo 拒绝请求（HTTP ${response.status}）；实验已停止且不会自动重试`,
        `prompt_lab_http_${response.status}`,
        uncertain,
        response.status,
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_CHARS) {
      throw new ByokProviderError('MiMo 响应过大，是否已计费不确定；实验已停止', 'prompt_lab_response_too_large', true, response.status);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new ByokProviderError('MiMo 响应过大，是否已计费不确定；实验已停止', 'prompt_lab_response_too_large', true, response.status);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ByokProviderError('MiMo 返回了无效响应，是否已计费不确定；实验已停止', 'prompt_lab_invalid_response_json', true, response.status);
    }
    if (!isRecord(payload)) {
      throw new ByokProviderError('MiMo 返回格式无效，是否已计费不确定；实验已停止', 'prompt_lab_invalid_response_shape', true, response.status);
    }
    const choice = readChoice(payload);
    const message = isRecord(choice.message) ? choice.message : null;
    const content = typeof message?.content === 'string' && message.content.trim()
      ? message.content
      : null;
    const usage = readUsage(payload);
    const responseMetadata: PromptLabResponseMetadata = {
      content,
      actualModel: typeof payload.model === 'string' ? payload.model : null,
      providerResponseId: typeof payload.id === 'string' ? payload.id : null,
      usage,
      latencyMs: Date.now() - startedAt,
      estimatedCostCny: usage ? estimateMimoCostCny(usage.inputTokens, usage.outputTokens) : null,
      diagnostic: content ? diagnosePromptLabOutput(content) : null,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    };
    if (choice.finish_reason !== 'stop') {
      throw new PromptLabResponseError(
        `MiMo 明确以 finish_reason=${responseMetadata.finishReason ?? 'unknown'} 结束；本次响应和用量已记录，实验停止且不会自动重试`,
        'prompt_lab_incomplete',
        response.status,
        responseMetadata,
      );
    }
    if (!content) {
      throw new PromptLabResponseError(
        'MiMo 已返回响应但内容为空；本次用量已记录，实验停止且不会自动重试',
        'prompt_lab_empty_content',
        response.status,
        responseMetadata,
      );
    }
    return {
      content,
      actualModel: responseMetadata.actualModel,
      providerResponseId: responseMetadata.providerResponseId,
      usage,
      latencyMs: responseMetadata.latencyMs,
      estimatedCostCny: responseMetadata.estimatedCostCny,
      diagnostic: responseMetadata.diagnostic!,
    };
  } catch (error) {
    if (error instanceof ByokProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ByokProviderError(
        signal?.aborted
          ? '实验已停止；进行中的请求是否已计费不确定，不会自动重试'
          : 'MiMo 请求超时；是否已计费不确定，实验已停止且不会自动重试',
        signal?.aborted ? 'prompt_lab_cancelled_unknown' : 'prompt_lab_timeout',
        true,
      );
    }
    throw new ByokProviderError('网络连接中断；是否已计费不确定，实验已停止且不会自动重试', 'prompt_lab_network_unknown', true);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function readChoice(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
    throw new ByokProviderError('MiMo 没有返回有效结果，是否已计费不确定；实验已停止', 'prompt_lab_missing_choice', true);
  }
  return payload.choices[0];
}

function readUsage(payload: Record<string, unknown>): PromptLabCompletion['usage'] {
  if (!isRecord(payload.usage)) return null;
  const inputTokens = payload.usage.prompt_tokens;
  const outputTokens = payload.usage.completion_tokens;
  if (!Number.isInteger(inputTokens) || Number(inputTokens) < 0
    || !Number.isInteger(outputTokens) || Number(outputTokens) < 0) return null;
  const details = isRecord(payload.usage.prompt_tokens_details) ? payload.usage.prompt_tokens_details : null;
  const cached = details?.cached_tokens;
  return {
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
    totalTokens: Number(inputTokens) + Number(outputTokens),
    cachedInputTokens: Number.isInteger(cached) && Number(cached) >= 0 ? Number(cached) : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
