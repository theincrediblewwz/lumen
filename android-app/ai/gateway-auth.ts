const INSTALL_ID_KEY = 'learnstuff.gateway.install-id.v1';
const TOKEN_KEY = 'learnstuff.gateway.access-token.v1';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const REGISTRATION_TIMEOUT_MS = 15_000;

export type GatewayTokenProvider = {
  getAccessToken(gatewayUrl: string, options?: { forceRefresh?: boolean }): Promise<string>;
};

type StoredToken = {
  gatewayUrl: string;
  accessToken: string;
  expiresAt: number;
};

export class GatewayTokenError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GatewayTokenError';
  }
}

export const secureGatewayTokenProvider: GatewayTokenProvider = {
  async getAccessToken(gatewayUrl, options) {
    const SecureStore = await import('expo-secure-store');
    if (!options?.forceRefresh) {
      const saved = await readStoredToken(SecureStore);
      if (saved?.gatewayUrl === gatewayUrl && saved.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
        return saved.accessToken;
      }
    }
    const installId = await getOrCreateInstallId(SecureStore);
    const token = await registerAnonymousInstall(gatewayUrl, installId);
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(token));
    return token.accessToken;
  },
};

export async function clearGatewayAccessToken() {
  const SecureStore = await import('expo-secure-store');
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function getOrCreateInstallId(SecureStore: typeof import('expo-secure-store')) {
  const saved = await SecureStore.getItemAsync(INSTALL_ID_KEY);
  if (saved) return saved;
  const Crypto = await import('expo-crypto');
  const installId = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALL_ID_KEY, installId);
  return installId;
}

async function readStoredToken(SecureStore: typeof import('expo-secure-store')): Promise<StoredToken | null> {
  const value = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredToken>;
    if (typeof parsed.gatewayUrl !== 'string' || typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return parsed as StoredToken;
  } catch {
    return null;
  }
}

async function registerAnonymousInstall(gatewayUrl: string, installId: string): Promise<StoredToken> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${gatewayUrl}/v1/auth/anonymous`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as { accessToken?: unknown; expiresIn?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok) {
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : `Gateway 注册失败（HTTP ${response.status}）`;
      throw new GatewayTokenError(message, `auth_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500, response.status);
    }
    if (typeof payload?.accessToken !== 'string' || typeof payload.expiresIn !== 'number' || payload.expiresIn < 60) {
      throw new GatewayTokenError('Gateway 返回了无效的安装令牌', 'invalid_auth_response', false, response.status);
    }
    return { gatewayUrl, accessToken: payload.accessToken, expiresAt: Date.now() + payload.expiresIn * 1_000 };
  } catch (error) {
    if (error instanceof GatewayTokenError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GatewayTokenError('Gateway 注册超时', 'auth_timeout', true);
    }
    throw new GatewayTokenError('无法连接 Gateway 注册服务', 'auth_network_error', true);
  } finally {
    clearTimeout(timeout);
  }
}
