/**
 * AI 设置（M5-7）：baseURL / 模型 / API Key / 温度 + 隐私开关，持久化到 localStorage。
 *
 * 注意：一期先存 localStorage（本地优先、单机自用）。M5-7 后续可把 apiKey 迁到
 * Rust 侧 safeStorage 加密落盘；此处结构预留 `keyStored` 语义，前端不打印明文。
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
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  shareBoard: true,
};

const KEY = 'lumen.ai.v1';

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return { ...DEFAULT_AI_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(s: AiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

/** 配置是否已就绪（可发起对话）：需 baseUrl + model；OpenAI 兼容还需 apiKey */
export function isAiConfigured(s: AiSettings): boolean {
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  if (s.kind === 'openai') return s.apiKey.trim().length > 0;
  return true; // ollama 等本地无需 key
}
