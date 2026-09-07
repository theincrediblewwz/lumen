import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  saveAiSettings,
  isAiConfigured,
} from './aiSettings';

// 简易 localStorage 垫片（node 环境无 window）
beforeEach(() => {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: () => null,
    length: 0,
  } as Storage;
});

describe('aiSettings 持久化', () => {
  it('无数据返回默认', () => {
    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
  });
  it('保存后可读回，缺字段用默认补齐', () => {
    saveAiSettings({ ...DEFAULT_AI_SETTINGS, model: 'deepseek-chat', apiKey: 'sk-x' });
    const s = loadAiSettings();
    expect(s.model).toBe('deepseek-chat');
    expect(s.apiKey).toBe('sk-x');
    expect(s.temperature).toBe(0.7);
  });
});

describe('isAiConfigured', () => {
  it('openai 缺 key 未就绪', () => {
    expect(isAiConfigured({ ...DEFAULT_AI_SETTINGS, apiKey: '' })).toBe(false);
  });
  it('openai 齐全则就绪', () => {
    expect(isAiConfigured({ ...DEFAULT_AI_SETTINGS, apiKey: 'sk-x' })).toBe(true);
  });
  it('ollama 无需 key', () => {
    expect(
      isAiConfigured({ ...DEFAULT_AI_SETTINGS, kind: 'ollama', apiKey: '' }),
    ).toBe(true);
  });
  it('缺 model 未就绪', () => {
    expect(isAiConfigured({ ...DEFAULT_AI_SETTINGS, apiKey: 'sk-x', model: '' })).toBe(
      false,
    );
  });
});
