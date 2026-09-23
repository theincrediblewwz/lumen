import type { ExpansionContext, LearningExpansion } from '@/ai/graph-patch';
import {
  GatewayTokenError,
  secureGatewayTokenProvider,
  type GatewayTokenProvider,
} from '@/ai/gateway-auth';

const REQUEST_TIMEOUT_MS = 45_000;

export class AiGatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

export function getAiGatewayUrl() {
  const value = process.env.EXPO_PUBLIC_AI_GATEWAY_URL?.trim();
  if (!value) return null;
  return normalizeGatewayUrl(value);
}

export function normalizeGatewayUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiGatewayError('AI Gateway 地址无效', 'invalid_gateway_url', false);
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
  const isLocalHttp = url.protocol === 'http:' && localHosts.has(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new AiGatewayError('非本地 AI Gateway 必须使用 HTTPS', 'insecure_gateway_url', false);
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new AiGatewayError('AI Gateway 必须是纯 origin，不能包含凭据、路径或参数', 'invalid_gateway_origin', false);
  }
  return url.origin;
}

export function getExpansionAdapterMode(): 'gateway' | 'local' {
  return getAiGatewayUrl() ? 'gateway' : 'local';
}

export async function requestGraphExpansion(
  context: ExpansionContext,
  tokenProvider: GatewayTokenProvider = secureGatewayTokenProvider,
): Promise<LearningExpansion> {
  const gatewayUrl = getAiGatewayUrl();
  if (!gatewayUrl) throw new AiGatewayError('尚未配置 AI Gateway', 'gateway_not_configured', false);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let accessToken = await tokenProvider.getAccessToken(gatewayUrl);
    let response = await sendExpansionRequest(gatewayUrl, context, accessToken, controller.signal);
    if (response.status === 401) {
      accessToken = await tokenProvider.getAccessToken(gatewayUrl, { forceRefresh: true });
      response = await sendExpansionRequest(gatewayUrl, context, accessToken, controller.signal);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const details = getErrorDetails(payload);
      const message = details.message ?? `AI Gateway 请求失败（HTTP ${response.status}）`;
      throw new AiGatewayError(
        message,
        details.code ?? `http_${response.status}`,
        details.retryable ?? (response.status === 408 || response.status === 429 || response.status >= 500),
        response.status,
      );
    }
    return payload as LearningExpansion;
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    if (error instanceof GatewayTokenError) {
      throw new AiGatewayError(error.message, error.code, error.retryable, error.status);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiGatewayError('AI Gateway 请求超时', 'timeout', true);
    }
    throw new AiGatewayError('无法连接 AI Gateway', 'network_error', true);
  } finally {
    clearTimeout(timeout);
  }
}

function sendExpansionRequest(
  gatewayUrl: string,
  context: ExpansionContext,
  accessToken: string,
  signal: AbortSignal,
) {
  return fetch(`${gatewayUrl}/v1/graph/expand`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Request-Id': context.requestId,
    },
    body: JSON.stringify(context),
    signal,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) return null;
    throw new AiGatewayError('AI Gateway 返回的不是有效 JSON', 'invalid_json', false, response.status);
  }
}

function getErrorDetails(payload: unknown) {
  if (typeof payload !== 'object' || payload === null) {
    return { message: null, code: null, retryable: null };
  }
  const value = payload as {
    error?: { message?: unknown; code?: unknown; retryable?: unknown };
    message?: unknown;
  };
  const message = value.error?.message ?? value.message;
  return {
    message: typeof message === 'string' ? message : null,
    code: typeof value.error?.code === 'string' ? value.error.code : null,
    retryable: typeof value.error?.retryable === 'boolean' ? value.error.retryable : null,
  };
}
