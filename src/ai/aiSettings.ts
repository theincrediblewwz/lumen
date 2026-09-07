/**
 * AI 设置（M5-7）：baseURL / 模型 / API Key / 温度 + 隐私开关 + 上下文预算。
 *
 * 隐私（M5-7）：**API Key 绝不明文落盘**。
 *   - Tauri 下密钥交给操作系统原生凭据库（Keychain / 凭据管理器 / Secret Service），
 *     localStorage 里只存非敏感字段（baseUrl/model/温度/开关/预算）。
 *   - 浏览器预览（无凭据库）下退回 localStorage 存密钥，仅作开发便利。
 * 内存里的 AiSettings.apiKey 只用于当次发请求，随时可为空（表示"已保存但未载入"）。
 */

import type { ProviderKind } from './provider';

export interface AiSettings {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 是否允许 AI 读取白板内容（隐私开关，关=只当普通聊天） */
  shareBoard: boolean;
  /** 上下文 token 预算（发送给模型的历史+提示词上限，超出则压缩最旧历史）。 */
  contextBudget: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  shareBoard: true,
  contextBudget: 8000,
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
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    // 兼容旧版本：旧数据可能把 apiKey 存进了 localStorage，读回但下次保存会迁移走。
    return { ...DEFAULT_AI_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** 同步保存非敏感字段（剥离密钥），密钥请另走 saveAiSettings 异步版。 */
function saveNonSecret(s: AiSettings): void {
  try {
    const { apiKey: _omit, ...rest } = s;
    void _omit;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

/** 异步载入完整设置（含从凭据库取回的密钥）。应用/窗口初始化时调用。 */
export async function loadAiSettingsAsync(): Promise<AiSettings> {
  const base = loadAiSettings();
  try {
    if (hasTauri()) {
      const { api } = await import('../api');
      const key = await api.secretGet(secretAccount(base.kind));
      // 迁移：若旧数据把 key 留在 localStorage，读到就用（下次保存会写入凭据库并清掉）
      return { ...base, apiKey: key ?? base.apiKey ?? '' };
    }
    if (typeof localStorage !== 'undefined') {
      const key = localStorage.getItem(BROWSER_KEY);
      if (key) return { ...base, apiKey: key };
    }
  } catch {
    /* 读密钥失败不阻塞，返回无密钥设置，UI 会提示重新填写 */
  }
  return base;
}

/** 异步保存完整设置：非敏感字段进 localStorage，密钥进凭据库（或浏览器回退）。 */
export async function saveAiSettings(s: AiSettings): Promise<void> {
  saveNonSecret(s);
  try {
    if (hasTauri()) {
      const { api } = await import('../api');
      // 空字符串 = 清除；secret_set 内部已按空处理为删除
      await api.secretSet(secretAccount(s.kind), s.apiKey || '');
      // 清掉可能残留在 localStorage 的旧明文密钥
      const raw = localStorage.getItem(KEY);
      if (raw && raw.includes('"apiKey"')) {
        saveNonSecret(s); // rest 已不含 apiKey，覆盖即抹除
      }
      return;
    }
    if (typeof localStorage !== 'undefined') {
      if (s.apiKey) localStorage.setItem(BROWSER_KEY, s.apiKey);
      else localStorage.removeItem(BROWSER_KEY);
    }
  } catch {
    /* 写密钥失败仅告警，非致命 */
  }
}

/** 配置是否已就绪（可发起对话）：需 baseUrl + model；OpenAI 兼容还需 apiKey */
export function isAiConfigured(s: AiSettings): boolean {
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  if (s.kind === 'openai') return s.apiKey.trim().length > 0;
  return true; // ollama 等本地无需 key
}
