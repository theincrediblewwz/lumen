/**
 * AI 设置（M5-7）：baseURL / 模型 / API Key / 温度 + 隐私开关 + 上下文预算。
 *
 * 隐私（M5-7）：**API Key 绝不明文落盘**。
 *   - Tauri 下按每套配置选择系统凭据库或本机免提示加密文件。
 *     localStorage 里只存非敏感字段及存储方式，不存 Key 或设备加密密钥。
 *   - 浏览器预览（无凭据库）下退回 localStorage 存密钥，仅作开发便利。
 * 本机免提示模式的加密密钥同机存放，防护弱于系统钥匙串；用户已明确选择。
 * 内存里的 AiSettings.apiKey 可为空，savedKey 只在明确使用/保存后解析。
 */

import type { ProviderKind } from './provider';
import { modelLimits, modelTemperature, modelPreset } from './modelCatalog';

export interface AiSettings {
  kind: ProviderKind;
  baseUrl: string;
  endpointMode?: 'base' | 'legacy';
  apiKey: string;
  keyStorage?: 'local' | 'system';
  model: string;
  temperature: number;
  /** 是否允许 AI 读取白板内容（隐私开关，关=只当普通聊天） */
  shareBoard: boolean;
  /** 上下文 token 预算（发送给模型的历史+提示词上限，超出则压缩最旧历史）。 */
  contextBudget: number;
  memoryMode?:'auto'|'off';
  maxTokens?: number;
  profileId?: string;
  reasoningEffort?: string;
  /** In-memory reference only. Opening a window never decrypts the saved key. */
  savedKey?: { account: string; browserKey: string; baseUrl: string; kind: ProviderKind; storage: 'local' | 'system'; profileId?: string };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  endpointMode: 'base',
  apiKey: '',
  keyStorage: 'local',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  shareBoard: true,
  contextBudget: 8000,
  memoryMode:'auto',
};

const KEY = 'lumen.ai.v1';
/** 浏览器（无凭据库）回退存密钥用的键；Tauri 下不使用。 */
const BROWSER_KEY = 'lumen.ai.key.fallback';

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 凭据库账户名：按供应商区分，方便切换 openai/ollama 等各存各的。 */
export function secretAccount(kind: ProviderKind): string {
  return `apikey.${kind}`;
}

/** 同步读取非敏感设置（不含真实密钥）。用于首屏即时渲染，密钥随后异步补入。 */
export function loadAiSettings(): AiSettings {
  try {
    const profiles = readProfiles();
    const active = profiles.profiles.find(p => p.id === profiles.activeId);
    if (active) return { ...DEFAULT_AI_SETTINGS, ...active.settings, endpointMode:active.settings.endpointMode??'legacy', keyStorage: active.settings.keyStorage ?? 'system', profileId: active.id, apiKey: '' };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    // 兼容旧版本：旧数据可能把 apiKey 存进了 localStorage，读回但下次保存会迁移走。
    return { ...DEFAULT_AI_SETTINGS, ...parsed, endpointMode:parsed.endpointMode??'legacy', keyStorage: parsed.keyStorage ?? 'system' };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** 同步保存非敏感字段（剥离密钥），密钥请另走 saveAiSettings 异步版。 */
function saveNonSecret(s: AiSettings): void {
  const { apiKey: _omit, savedKey: _reference, ...rest } = s;
  void _omit;
  void _reference;
  localStorage.setItem(KEY, JSON.stringify(rest));
}

/** Metadata only: opening chat/settings must not read an OS credential. */
export function loadAiSettingsDeferred(): AiSettings {
  const base = loadAiSettings();
  if (base.profileId) return loadAiProfileDeferred(base.profileId);
  if (base.apiKey || !localStorage.getItem(KEY)) return base;
  return { ...base, savedKey: { account: secretAccount(base.kind), browserKey: BROWSER_KEY, baseUrl: base.baseUrl, kind: base.kind, storage: base.keyStorage ?? 'system' } };
}

export function hasSavedAiKey(s: AiSettings): boolean {
  return Boolean(s.savedKey && s.savedKey.baseUrl === s.baseUrl && s.savedKey.kind === s.kind);
}

/** Explicit use/save only. Denied access must not look like an empty saved key. */
export async function resolveAiCredentials(s: AiSettings): Promise<AiSettings> {
  if (s.apiKey || !s.savedKey) return s;
  if (!hasSavedAiKey(s)) throw new Error('连接地址已改变，请为新接口填写密钥。原配置未更改。');
  const { savedKey, ...base } = s;
  // Another window may have saved the same profile with a new credential
  // version. Resolve its current reference only for the same exact connection.
  let reference = savedKey;
  if (savedKey.profileId) {
    const latest = loadAiProfileDeferred(savedKey.profileId);
    if (latest.baseUrl !== s.baseUrl || latest.kind !== s.kind) throw new Error('这套连接已由另一窗口更改，请重新选择配置。原密钥未更改。');
    reference = latest.savedKey!;
  }
  let key: string | null;
  if (hasTauri()) {
    const { api } = await import('../api');
    key = await api.secretGet(reference.account, reference.storage);
  } else key = localStorage.getItem(reference.browserKey);
  return { ...base, apiKey: key ?? '' };
}

/** Explicit use only. Window initialization uses loadAiSettingsDeferred. */
export async function loadAiSettingsAsync(): Promise<AiSettings> {
  const base = loadAiSettingsDeferred();
  return base.profileId ? loadAiProfile(base.profileId) : resolveAiCredentials(base);
}

/** 异步保存完整设置：非敏感字段进 localStorage，密钥进凭据库（或浏览器回退）。 */
export async function saveAiSettings(s: AiSettings): Promise<void> {
  if (s.profileId) { await saveAiProfile(s, listAiProfiles().find(p => p.id === s.profileId)?.name ?? '我的配置'); return; }
  if (s.savedKey) {
    s = await resolveAiCredentials(s);
    if (!s.apiKey && s.kind === 'openai') throw new Error('未能读取已保存密钥，原配置已保留。请重新授权或填写密钥。');
  }
  s = normalizeAiSettings(s);
  let previousKey = '';
  let keyWritten = false;
  const writeKey = async (key: string) => {
    if (hasTauri()) {
      const { api } = await import('../api');
      await api.secretSet(secretAccount(s.kind), key, s.keyStorage ?? 'system');
      return;
    }
    if (key) localStorage.setItem(BROWSER_KEY, key);
    else localStorage.removeItem(BROWSER_KEY);
  };
  try {
    if (hasTauri()) { const { api } = await import('../api'); previousKey = await api.secretGet(secretAccount(s.kind), s.keyStorage ?? 'system') ?? ''; }
    else previousKey = localStorage.getItem(BROWSER_KEY) ?? '';
    await writeKey(s.apiKey || ''); keyWritten = true;
    saveNonSecret(s);
  } catch {
    if (keyWritten) await writeKey(previousKey).catch(() => {});
    throw new Error('配置未保存：无法写入凭据库或本机设置，请重试。');
  }
}

const PROFILE_PREFIX = 'lumen.ai.profile.v1.';
export interface AiProfile { id: string; name: string; keyId?: string; updatedAt?: number; settings: Omit<AiSettings, 'apiKey'> }
interface Profiles { version: 1; activeId?: string; profiles: AiProfile[] }
function readProfiles(): Profiles {
  try {
    const profiles: AiProfile[] = [];
    // One atomic record per profile: concurrent windows never replace an entire
    // shared list. The most recently saved record selects the active profile.
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(PROFILE_PREFIX)) continue;
      try {
        const p = JSON.parse(localStorage.getItem(key) ?? 'null') as AiProfile;
        if (p && /^[\w-]{1,80}$/.test(p.id) && key === PROFILE_PREFIX + p.id && typeof p.name === 'string' && p.settings) profiles.push(p);
      } catch { /* Ignore one damaged profile, not all the other saved profiles. */ }
    }
    profiles.sort((a, b) => ((a.updatedAt ?? 0) - (b.updatedAt ?? 0)) || (a.keyId ?? a.id).localeCompare(b.keyId ?? b.id));
    return { version: 1, activeId: profiles[profiles.length - 1]?.id, profiles };
  } catch { /* Legacy settings remain available. */ }
  return { version: 1, profiles: [] };
}
export function listAiProfiles(): AiProfile[] { return readProfiles().profiles; }
function newProfileId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
}
export function profileSecretAccount(id: string, keyId?: string): string {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('配置标识无效');
  if (keyId && !/^[\w-]{1,80}$/.test(keyId)) throw new Error('凭据标识无效');
  return `apikey.profile.${id}${keyId ? `.${keyId}` : ''}`;
}
export function normalizeAiSettings(s: AiSettings): AiSettings {
  const limits = modelLimits(s.model, s.maxTokens, s.baseUrl);
  const reasoning = modelPreset(s.model, s.baseUrl)?.reasoning;
  const normalized = {
    ...s,
    contextBudget: Math.min(limits.maxInput, Math.max(1000, Math.floor(Number.isFinite(s.contextBudget) ? s.contextBudget : 8000))),
    temperature: modelTemperature(s.model, s.temperature,modelPreset(s.model,s.baseUrl)??null),
    reasoningEffort: reasoning ? (reasoning.levels.includes(s.reasoningEffort ?? '') ? s.reasoningEffort : reasoning.default) : undefined,
  };
  // Preserve the original no-explicit-output setting for legacy/custom models.
  if (s.maxTokens !== undefined || limits.known) normalized.maxTokens = limits.output;
  return normalized;
}
export function loadAiProfileDeferred(id: string): AiSettings {
  const profile = listAiProfiles().find(p => p.id === id);
  if (!profile) throw new Error('找不到这套配置');
  const settings = { ...DEFAULT_AI_SETTINGS, ...profile.settings, endpointMode:profile.settings.endpointMode??'legacy' as const, keyStorage: profile.settings.keyStorage ?? 'system', profileId: id, apiKey: '' };
  return { ...settings, savedKey: { account: profileSecretAccount(id, profile.keyId), browserKey: `${BROWSER_KEY}.${id}${profile.keyId ? `.${profile.keyId}` : ''}`, baseUrl: settings.baseUrl, kind: settings.kind, storage: settings.keyStorage, profileId: id } };
}
async function writeProfileKey(id: string, key: string, keyId?: string, storage: 'local' | 'system' = 'system'): Promise<void> {
  const account = profileSecretAccount(id, keyId);
  if (hasTauri()) { const { api } = await import('../api'); await api.secretSet(account, key, storage); return; }
  const storageKey = `${BROWSER_KEY}.${id}${keyId ? `.${keyId}` : ''}`;
  if (key) localStorage.setItem(storageKey, key);
  else localStorage.removeItem(storageKey);
}
export async function loadAiProfile(id: string): Promise<AiSettings> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = listAiProfiles().find(p => p.id === id);
    if (!profile) throw new Error('找不到这套配置');
    const loaded = await resolveAiCredentials(loadAiProfileDeferred(id));
    if (listAiProfiles().find(p => p.id === id)?.keyId !== profile.keyId) continue;
    return loaded;
  }
  throw new Error('配置正在被其他窗口更新，请重新选择。');
}
/** Explicit save only. One atomic metadata write, credentials isolated by stable profile ID. */
export async function saveAiProfile(s: AiSettings, name: string): Promise<AiSettings> {
  if (!name.trim()) throw new Error('请为这套配置命名');
  if (s.savedKey) {
    s = await resolveAiCredentials(s);
    if (!s.apiKey && s.kind === 'openai') throw new Error('未能读取已保存密钥，原配置已保留。请重新授权或填写密钥。');
  }
  const id = s.profileId ?? newProfileId();
  profileSecretAccount(id);
  const keyId = newProfileId();
  const normalized = normalizeAiSettings({ ...s, profileId: id });
  const { apiKey, savedKey: _reference, ...nonSecret } = normalized;
  void _reference;
  // Each save writes a fresh credential, so concurrent windows cannot pair old
  // metadata with another window's new key or undo another successful save.
  await writeProfileKey(id, apiKey, keyId, normalized.keyStorage);
  const before = readProfiles();
  const updatedAt = Math.max(Date.now(), ...before.profiles.map(p => (p.updatedAt ?? 0) + 1));
  const profile = { id, keyId, updatedAt, name: name.trim().slice(0, 80), settings: nonSecret };
  try {
    localStorage.setItem(PROFILE_PREFIX + id, JSON.stringify(profile));
  } catch {
    await writeProfileKey(id, '', keyId, normalized.keyStorage).catch(() => {});
    throw new Error('配置未保存：本机设置写入失败，原配置已保留。');
  }
  const replaced = before.profiles.find(p => p.id === id);
  // Cross-store migration preserves the original credential for rollback. Never
  // delete a Keychain entry merely because the user opted into prompt-free storage.
  if (replaced && (replaced.settings.keyStorage ?? 'system') === (normalized.keyStorage ?? 'system')) await writeProfileKey(id, '', replaced.keyId, replaced.settings.keyStorage).catch(() => {});
  return normalized;
}

/** 配置是否已就绪（可发起对话）：需 baseUrl + model；OpenAI 兼容还需 apiKey */
export function isAiConfigured(s: AiSettings): boolean {
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  if (s.kind === 'openai') return s.apiKey.trim().length > 0 || hasSavedAiKey(s);
  return true; // ollama 等本地无需 key
}
