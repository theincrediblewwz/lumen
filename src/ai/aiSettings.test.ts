import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  loadAiSettingsAsync,
  saveAiSettings,
  isAiConfigured,
  secretAccount,
} from './aiSettings';

// 简易 localStorage 垫片（node 环境无 window）。
// 注意：测试跑在非 Tauri 环境，密钥走「浏览器回退」分支（localStorage 的 fallback 键）。
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

  it('非敏感字段保存后可读回，缺字段用默认补齐', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, model: 'deepseek-chat', apiKey: 'sk-x' });
    const s = loadAiSettings();
    expect(s.model).toBe('deepseek-chat');
    expect(s.temperature).toBe(0.7);
  });

  it('API Key 不写进主设置 localStorage（隐私）', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'sk-secret-123' });
    const raw = localStorage.getItem('lumen.ai.v1') ?? '';
    expect(raw).not.toContain('sk-secret-123');
    expect(raw).not.toContain('apiKey');
  });

  it('浏览器回退下密钥可异步读回', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'sk-roundtrip' });
    const s = await loadAiSettingsAsync();
    expect(s.apiKey).toBe('sk-roundtrip');
  });

  it('清空密钥后异步读回为空', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'sk-x' });
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: '' });
    const s = await loadAiSettingsAsync();
    expect(s.apiKey).toBe('');
  });

  it('secretAccount 按供应商区分', () => {
    expect(secretAccount('openai')).not.toBe(secretAccount('ollama'));
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
