export const DEEPSEEK_BYOK_PRESET = {
  kind: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  jsonMode: true,
  tokenLimitField: 'max_tokens',
} as const satisfies ByokProfile;

export const MIMO_BYOK_PRESET = {
  kind: 'mimo',
  label: 'Xiaomi MiMo',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5',
  jsonMode: true,
  tokenLimitField: 'max_completion_tokens',
} as const satisfies ByokProfile;

const PROFILE_KEY = 'learnstuff.byok.profile.v1';
const API_KEY_KEY = 'learnstuff.byok.api-key.v1';
const PROFILE_VERSION = 1;

export type ByokProfile = {
  kind: 'deepseek' | 'mimo' | 'custom';
  label: string;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  tokenLimitField: 'max_tokens' | 'max_completion_tokens' | 'none';
};

export type ByokCredentials = {
  profile: ByokProfile;
  apiKey: string;
};

type StoredProfile = {
  version: typeof PROFILE_VERSION;
  profile: ByokProfile;
};

type StoredApiKey = {
  version: typeof PROFILE_VERSION;
  baseUrl: string;
  apiKey: string;
};

export type SecureStoreClient = Pick<
  typeof import('expo-secure-store'),
  'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'
>;

export class ByokConfigurationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ByokConfigurationError';
  }
}

export function normalizeByokProfile(input: ByokProfile): ByokProfile {
  const label = input.label.trim();
  const model = input.model.trim();
  if (!label || label.length > 40) {
    throw new ByokConfigurationError('服务名称需要填写，且不能超过 40 个字符', 'invalid_label');
  }
  if (!model || model.length > 120) {
    throw new ByokConfigurationError('模型名称需要填写，且不能超过 120 个字符', 'invalid_model');
  }
  if (input.kind !== 'deepseek' && input.kind !== 'mimo' && input.kind !== 'custom') {
    throw new ByokConfigurationError('不支持的服务类型', 'invalid_kind');
  }
  if (!['max_tokens', 'max_completion_tokens', 'none'].includes(input.tokenLimitField)) {
    throw new ByokConfigurationError('输出 token 参数无效', 'invalid_token_limit_field');
  }
  const baseUrl = normalizeByokBaseUrl(input.baseUrl);
  if (input.kind === 'deepseek' && baseUrl !== DEEPSEEK_BYOK_PRESET.baseUrl) {
    throw new ByokConfigurationError('DeepSeek 预设只能使用官方 API 地址', 'invalid_deepseek_origin');
  }
  if (input.kind === 'mimo' && baseUrl !== MIMO_BYOK_PRESET.baseUrl) {
    throw new ByokConfigurationError('MiMo 预设只能使用官方 API 地址', 'invalid_mimo_origin');
  }
  return {
    kind: input.kind,
    label,
    baseUrl,
    model,
    jsonMode: Boolean(input.jsonMode),
    tokenLimitField: input.tokenLimitField,
  };
}

export function normalizeByokBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ByokConfigurationError('Base URL 无效', 'invalid_base_url');
  }
  if (url.protocol !== 'https:') {
    throw new ByokConfigurationError('远程 AI 服务必须使用 HTTPS', 'insecure_base_url');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ByokConfigurationError('Base URL 不能包含账号、密码、查询参数或片段', 'unsafe_base_url');
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (/\/chat\/completions$/iu.test(pathname)) {
    throw new ByokConfigurationError('请填写 Base URL，不要包含 /chat/completions', 'completion_path_in_base_url');
  }
  if (pathname.length > 200) {
    throw new ByokConfigurationError('Base URL 路径过长', 'base_url_too_long');
  }
  return `${url.origin}${pathname}`;
}

export function createChatCompletionsUrl(baseUrl: string) {
  return `${normalizeByokBaseUrl(baseUrl)}/chat/completions`;
}

export function normalizeApiKey(value: string) {
  const key = value.trim();
  if (key.length < 8 || key.length > 4096 || /[\r\n]/u.test(key)) {
    throw new ByokConfigurationError('API key 格式无效', 'invalid_api_key');
  }
  return key;
}

export async function getByokProfileStatus(store?: SecureStoreClient): Promise<{ profile: ByokProfile | null; hasApiKey: boolean }> {
  const SecureStore = store ?? await import('expo-secure-store');
  const [profileValue, apiKeyValue] = await Promise.all([
    SecureStore.getItemAsync(PROFILE_KEY),
    SecureStore.getItemAsync(API_KEY_KEY),
  ]);
  const profile = parseStoredProfile(profileValue);
  const apiKey = parseStoredApiKey(apiKeyValue);
  return { profile, hasApiKey: Boolean(profile && apiKey?.baseUrl === profile.baseUrl) };
}

export async function getByokCredentials(store?: SecureStoreClient): Promise<ByokCredentials | null> {
  const SecureStore = store ?? await import('expo-secure-store');
  const [profileValue, apiKeyValue] = await Promise.all([
    SecureStore.getItemAsync(PROFILE_KEY),
    SecureStore.getItemAsync(API_KEY_KEY),
  ]);
  const profile = parseStoredProfile(profileValue);
  const keyRecord = parseStoredApiKey(apiKeyValue);
  if (!profile || !keyRecord || keyRecord.baseUrl !== profile.baseUrl) return null;
  return { profile, apiKey: keyRecord.apiKey };
}

export async function saveByokProfile(profileInput: ByokProfile, apiKeyInput?: string, store?: SecureStoreClient) {
  const SecureStore = store ?? await import('expo-secure-store');
  const profile = normalizeByokProfile(profileInput);
  const [existingProfile, existingKey] = await Promise.all([
    SecureStore.getItemAsync(PROFILE_KEY),
    SecureStore.getItemAsync(API_KEY_KEY),
  ]);
  const apiKey = resolveApiKeyForProfile(profile, apiKeyInput, existingKey);
  const stored: StoredProfile = { version: PROFILE_VERSION, profile };
  const storedKey: StoredApiKey = { version: PROFILE_VERSION, baseUrl: profile.baseUrl, apiKey };
  try {
    await SecureStore.setItemAsync(API_KEY_KEY, JSON.stringify(storedKey));
    await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(stored));
  } catch (error) {
    await restoreSecureValue(SecureStore, API_KEY_KEY, existingKey);
    await restoreSecureValue(SecureStore, PROFILE_KEY, existingProfile);
    throw error;
  }
  return profile;
}

async function restoreSecureValue(
  SecureStore: SecureStoreClient,
  key: string,
  value: string | null,
) {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // The original storage failure is still the actionable error; never include secret material.
  }
}

export async function clearByokProfile(store?: SecureStoreClient) {
  const SecureStore = store ?? await import('expo-secure-store');
  await Promise.all([
    SecureStore.deleteItemAsync(PROFILE_KEY),
    SecureStore.deleteItemAsync(API_KEY_KEY),
  ]);
}

export function parseStoredProfile(value: string | null): ByokProfile | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredProfile>;
    if (parsed.version !== PROFILE_VERSION || !parsed.profile) return null;
    return normalizeByokProfile(parsed.profile);
  } catch {
    return null;
  }
}

export function resolveApiKeyForProfile(profile: ByokProfile, apiKeyInput: string | undefined, storedValue: string | null) {
  if (apiKeyInput?.trim()) return normalizeApiKey(apiKeyInput);
  const existing = parseStoredApiKey(storedValue);
  if (existing?.baseUrl === profile.baseUrl) return existing.apiKey;
  throw new ByokConfigurationError(
    existing ? '更换 Base URL 后必须重新填写 API key' : '首次保存需要填写 API key',
    existing ? 'api_key_reentry_required' : 'api_key_required',
  );
}

export function parseStoredApiKey(value: string | null): StoredApiKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredApiKey>;
    if (parsed.version !== PROFILE_VERSION || typeof parsed.baseUrl !== 'string' || typeof parsed.apiKey !== 'string') return null;
    return {
      version: PROFILE_VERSION,
      baseUrl: normalizeByokBaseUrl(parsed.baseUrl),
      apiKey: normalizeApiKey(parsed.apiKey),
    };
  } catch {
    return null;
  }
}
