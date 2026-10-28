import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  loadAiSettingsAsync,
  saveAiSettings,
  isAiConfigured,
  secretAccount,
  saveAiProfile, loadAiProfile, listAiProfiles, normalizeAiSettings,
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
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() { return Object.keys(store).length; },
  } as Storage;
});

describe('named configurations', () => {
  it('retains the original address, opaque key reference and legacy route for existing custom connections',()=>{
    const old={...DEFAULT_AI_SETTINGS,baseUrl:'https://gateway.example/openai'};
    delete old.endpointMode;
    const raw=JSON.stringify(old);localStorage.setItem('lumen.ai.v1',raw);
    const loaded=loadAiSettings();
    expect(loaded.baseUrl).toBe(old.baseUrl);expect(loaded.endpointMode).toBe('legacy');
    expect(localStorage.getItem('lumen.ai.v1')).toBe(raw);
  });
  it('merges simultaneous profile saves without losing either configuration', async () => {
    await Promise.all([
      saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'concurrent-a' }, 'A'),
      saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'concurrent-b' }, 'B'),
    ]);
    expect(listAiProfiles()).toHaveLength(2);
    for (const profile of listAiProfiles()) expect((await loadAiProfile(profile.id)).apiKey).toBe(profile.name === 'A' ? 'concurrent-a' : 'concurrent-b');
  });
  it('rolls back legacy credentials if the legacy metadata write fails', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'legacy-original' });
    const setter = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'lumen.ai.v1') throw new Error('synthetic full');
      setter(key, value);
    });
    await expect(saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'new-key', model: 'new-model' })).rejects.toThrow('未保存');
    spy.mockRestore();
    expect((await loadAiSettingsAsync()).apiKey).toBe('legacy-original');
    expect(loadAiSettings().model).toBe(DEFAULT_AI_SETTINGS.model);
  });
  it('separates keys for two OpenAI-compatible profiles and retains legacy settings', async () => {
    await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'fixture-key-1' });
    const a = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'synthetic-a', model: 'deepseek-flash' }, 'DeepSeek 学习');
    const b = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'synthetic-b', model: 'mimo-v2.6-pro' }, 'MiMo 学习');
    expect(a.profileId).not.toBe(b.profileId);
    expect((await loadAiProfile(a.profileId!)).apiKey).toBe('synthetic-a');
    expect((await loadAiSettingsAsync()).apiKey).toBe('synthetic-b');
    expect(listAiProfiles()).toHaveLength(2);
    const metadata = JSON.stringify(listAiProfiles());
    expect(metadata).not.toMatch(/synthetic-a|synthetic-b|apiKey/);
    expect(localStorage.getItem('lumen.ai.key.fallback')).toBe('fixture-key-1');
    await saveAiProfile({ ...(await loadAiProfile(a.profileId!)), contextBudget: 9000 }, '改名');
    expect(listAiProfiles()).toHaveLength(2);
    expect((await loadAiProfile(b.profileId!)).apiKey).toBe('synthetic-b');
  });
  it('leaves active profile and key unchanged when metadata cannot be saved', async () => {
    const original = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'original' }, '原配置');
    const setter = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('lumen.ai.profile.v1.')) throw new Error('synthetic disk full');
      setter(key, value);
    });
    await expect(saveAiProfile({ ...original, apiKey: 'replacement', model: 'new' }, '修改')).rejects.toThrow('原配置已保留');
    spy.mockRestore();
    expect((await loadAiSettingsAsync()).apiKey).toBe('original');
    expect(loadAiSettings().model).toBe(DEFAULT_AI_SETTINGS.model);
  });
  it('does not activate a profile after a credential-write failure', async () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('synthetic permission'); });
    await expect(saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'not-saved' }, '新配置')).rejects.toThrow();
    spy.mockRestore();
    expect(listAiProfiles()).toEqual([]);
    expect(loadAiSettings().profileId).toBeUndefined();
  });
  it('enforces numeric limits and preserves sharing permission', () => {
    const s = normalizeAiSettings({ ...DEFAULT_AI_SETTINGS, baseUrl:'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', maxTokens: Infinity, contextBudget: Infinity, temperature: 10, shareBoard: false });
    expect(s.contextBudget).toBe(8000);
    expect(s.maxTokens).toBe(131072);
    expect(s.temperature).toBe(1);
    expect(s.shareBoard).toBe(false);
  });
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
