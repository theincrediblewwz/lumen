import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { DEFAULT_AI_SETTINGS, hasSavedAiKey, isAiConfigured, listAiProfiles, loadAiProfileDeferred, loadAiSettingsDeferred, resolveAiCredentials, saveAiProfile, saveAiSettings } from './aiSettings';

vi.mock('../api', () => ({ api: { secretGet: vi.fn(), secretSet: vi.fn() } }));
let storage: Record<string, string>;
let vault: Record<string, string>;
beforeEach(() => {
  storage = {}; vault = {}; vi.clearAllMocks();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value; },
    removeItem: (key: string) => { delete storage[key]; },
    key: (index: number) => Object.keys(storage)[index] ?? null,
    get length() { return Object.keys(storage).length; },
  });
  vi.mocked(api.secretGet).mockImplementation(async (account, storage = 'system') => vault[`${storage}:${account}`] ?? null);
  vi.mocked(api.secretSet).mockImplementation(async (account, key, storage = 'system') => { if (key) vault[`${storage}:${account}`] = key; else delete vault[`${storage}:${account}`]; });
});
afterEach(() => vi.unstubAllGlobals());

it('opening/reopening chat and selecting profiles reads only metadata, while explicit use resolves the saved key', async () => {
  const a = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-key-A' }, 'A');
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-key-B' }, 'B');
  vi.mocked(api.secretGet).mockClear();
  const before = JSON.stringify(storage);
  for (let window = 0; window < 4; window++) {
    expect(loadAiSettingsDeferred().apiKey).toBe('');
    expect(isAiConfigured(loadAiSettingsDeferred())).toBe(true);
    expect(hasSavedAiKey(loadAiProfileDeferred(a.profileId!))).toBe(true);
  }
  expect(api.secretGet).not.toHaveBeenCalled();
  expect((await resolveAiCredentials(loadAiProfileDeferred(a.profileId!))).apiKey).toBe('qa-key-A');
  expect(JSON.stringify(storage)).toBe(before);
  expect(before).not.toMatch(/qa-key-|apiKey|savedKey/);
});

it('cancelled or missing credentials cannot overwrite saved metadata/key during save, and retry succeeds', async () => {
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-original' }, '原配置');
  const draft = { ...loadAiSettingsDeferred(), contextBudget: 20000 };
  const before = JSON.stringify({ storage, vault });
  vi.mocked(api.secretGet).mockRejectedValueOnce(new Error('cancelled'));
  await expect(saveAiProfile(draft, '修改')).rejects.toThrow('cancelled');
  expect(JSON.stringify({ storage, vault })).toBe(before);
  vi.mocked(api.secretGet).mockResolvedValueOnce(null);
  await expect(saveAiProfile(draft, '修改')).rejects.toThrow('原配置已保留');
  expect(JSON.stringify({ storage, vault })).toBe(before);
  await saveAiProfile(draft, '修改');
  expect((await resolveAiCredentials(loadAiSettingsDeferred())).apiKey).toBe('qa-original');
  expect(loadAiSettingsDeferred().contextBudget).toBe(20000);
});

it('legacy accounts remain deferred and save-as copies the correct stored key without persisting references', async () => {
  await saveAiSettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-legacy', keyStorage: 'system' });
  vi.mocked(api.secretGet).mockClear();
  const legacy = loadAiSettingsDeferred();
  expect(legacy.savedKey?.account).toBe('apikey.openai');
  expect(api.secretGet).not.toHaveBeenCalled();
  const first = await saveAiProfile(legacy, '原配置');
  await saveAiProfile({ ...loadAiProfileDeferred(first.profileId!), profileId: undefined }, '副本');
  expect(listAiProfiles()).toHaveLength(2);
  for (const p of listAiProfiles()) expect((await resolveAiCredentials(loadAiProfileDeferred(p.id))).apiKey).toBe('qa-legacy');
  expect(JSON.stringify(storage)).not.toMatch(/qa-legacy|savedKey|apiKey/);
});

it('old profiles without storage metadata stay in Keychain; migration writes local before switching and preserves the original', async () => {
  const original = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-original', keyStorage: 'system' }, '原配置');
  const key = 'lumen.ai.profile.v1.' + original.profileId;
  const old = JSON.parse(storage[key]); delete old.settings.keyStorage; storage[key] = JSON.stringify(old);
  const deferred = loadAiSettingsDeferred();
  expect(deferred.keyStorage).toBe('system');
  expect(deferred.savedKey?.storage).toBe('system');
  const oldVault = { ...vault }; const before = JSON.stringify(storage);
  vi.mocked(api.secretSet).mockRejectedValueOnce(new Error('local write failed'));
  await expect(saveAiProfile({ ...deferred, keyStorage: 'local' }, '原配置')).rejects.toThrow('local write failed');
  expect(JSON.stringify(storage)).toBe(before); expect(vault).toEqual(oldVault);
  await saveAiProfile({ ...deferred, keyStorage: 'local' }, '原配置');
  expect(loadAiSettingsDeferred().savedKey?.storage).toBe('local');
  expect((await resolveAiCredentials(loadAiSettingsDeferred())).apiKey).toBe('qa-original');
  for (const [account, value] of Object.entries(oldVault)) expect(vault[account]).toBe(value);
  expect(Object.keys(vault).some(k => k.startsWith('local:'))).toBe(true);
});

it('manual re-entry switches to prompt-free storage without reading the old Keychain key', async () => {
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-original', keyStorage: 'system' }, '原配置');
  vi.mocked(api.secretGet).mockClear();
  vi.mocked(api.secretGet).mockRejectedValue(new Error('OS auth would be required'));
  await saveAiProfile({ ...loadAiSettingsDeferred(), savedKey: undefined, apiKey: 'qa-entered', keyStorage: 'local' }, '原配置');
  expect(api.secretGet).not.toHaveBeenCalled();
  expect(loadAiSettingsDeferred().keyStorage).toBe('local');
});

it('metadata failure during cross-store migration leaves the original Keychain reference intact', async () => {
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, keyStorage: 'system', apiKey: 'qa-original' }, '原配置');
  const original = JSON.stringify(storage), oldVault = { ...vault };
  const setter = localStorage.setItem.bind(localStorage);
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.startsWith('lumen.ai.profile.v1.')) throw Error('disk full');
    setter(key, value);
  });
  await expect(saveAiProfile({ ...loadAiSettingsDeferred(), keyStorage: 'local' }, '原配置')).rejects.toThrow('原配置已保留');
  spy.mockRestore();
  expect(JSON.stringify(storage)).toBe(original); expect(vault).toEqual(oldVault);
  expect(loadAiSettingsDeferred().savedKey?.storage).toBe('system');
});

it('existing keyless local-model configurations remain editable', async () => {
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, kind: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434', model: 'local-model' }, '本地模型');
  await expect(saveAiProfile({ ...loadAiSettingsDeferred(), contextBudget: 12000 }, '本地模型')).resolves.toMatchObject({ kind: 'ollama', apiKey: '' });
});

it('a credential reference can never be sent to a changed endpoint or provider kind', async () => {
  await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-private' }, '原配置');
  vi.mocked(api.secretGet).mockClear();
  const saved = loadAiSettingsDeferred();
  for (const change of [{ baseUrl: 'https://other.invalid/v1' }, { kind: 'ollama' as const }]) {
    expect(hasSavedAiKey({ ...saved, ...change })).toBe(false);
    await expect(resolveAiCredentials({ ...saved, ...change })).rejects.toThrow('连接地址已改变');
  }
  expect(api.secretGet).not.toHaveBeenCalled();
});

it('a second window resolves a newly saved credential version only for its original connection', async () => {
  const a = await saveAiProfile({ ...DEFAULT_AI_SETTINGS, apiKey: 'qa-original' }, 'A');
  const deferred = loadAiSettingsDeferred();
  await saveAiProfile({ ...a, apiKey: 'qa-replaced' }, 'A');
  expect((await resolveAiCredentials(deferred)).apiKey).toBe('qa-replaced');
  await saveAiProfile({ ...a, baseUrl: 'https://new.invalid/v1', apiKey: 'qa-new' }, 'A');
  vi.mocked(api.secretGet).mockClear();
  await expect(resolveAiCredentials(deferred)).rejects.toThrow('另一窗口更改');
  expect(api.secretGet).not.toHaveBeenCalled();
});
