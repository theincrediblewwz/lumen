import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChatCompletionsUrl,
  clearByokProfile,
  DEEPSEEK_BYOK_PRESET,
  getByokCredentials,
  getByokProfileStatus,
  MIMO_BYOK_PRESET,
  normalizeByokBaseUrl,
  normalizeByokProfile,
  parseStoredApiKey,
  parseStoredProfile,
  resolveApiKeyForProfile,
  saveByokProfile,
  type SecureStoreClient,
} from '../ai/byok-profile';

test('keeps DeepSeek as a preset while accepting a custom OpenAI-compatible v1 base path', () => {
  assert.deepEqual(normalizeByokProfile({ ...DEEPSEEK_BYOK_PRESET }), DEEPSEEK_BYOK_PRESET);
  assert.deepEqual(normalizeByokProfile({ ...MIMO_BYOK_PRESET }), MIMO_BYOK_PRESET);
  const custom = normalizeByokProfile({
    kind: 'custom',
    label: ' Example AI ',
    baseUrl: 'https://api.example.com/v1/',
    model: ' example-model ',
    jsonMode: false,
    tokenLimitField: 'max_completion_tokens',
  });
  assert.equal(custom.baseUrl, 'https://api.example.com/v1');
  assert.equal(custom.model, 'example-model');
  assert.equal(custom.tokenLimitField, 'max_completion_tokens');
  assert.equal(createChatCompletionsUrl(custom.baseUrl), 'https://api.example.com/v1/chat/completions');
});

test('locks the MiMo preset to the official v1 endpoint', () => {
  assert.throws(
    () => normalizeByokProfile({ ...MIMO_BYOK_PRESET, baseUrl: 'https://example.com/v1' }),
    /MiMo 预设只能使用官方 API 地址/,
  );
});

test('binds a stored API key to one Base URL and requires re-entry after destination changes', () => {
  const profile = normalizeByokProfile({
    kind: 'custom', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', jsonMode: true,
    tokenLimitField: 'max_tokens',
  });
  const stored = JSON.stringify({ version: 1, baseUrl: profile.baseUrl, apiKey: 'fixture-key' });
  assert.equal(parseStoredApiKey(stored)?.baseUrl, profile.baseUrl);
  assert.equal(resolveApiKeyForProfile(profile, undefined, stored), 'fixture-key');
  assert.throws(
    () => resolveApiKeyForProfile({ ...profile, baseUrl: 'https://b.example.com/v1' }, undefined, stored),
    /更换 Base URL/,
  );
});

test('stores the key only in a Base-URL-bound SecureStore record and clears both records', async () => {
  const values = new Map<string, string>();
  const store: SecureStoreClient = {
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  };
  const profile = normalizeByokProfile({
    kind: 'custom', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', jsonMode: true,
    tokenLimitField: 'max_tokens',
  });
  await saveByokProfile(profile, 'fixture-key', store);
  assert.deepEqual(await getByokProfileStatus(store), { profile, hasApiKey: true });
  assert.deepEqual(await getByokCredentials(store), { profile, apiKey: 'fixture-key' });
  assert.equal([...values.values()].some((value) => value === 'fixture-key'), false);
  assert.equal([...values.values()].some((value) => value.includes('"baseUrl":"https://a.example.com/v1"')), true);

  await assert.rejects(
    saveByokProfile({ ...profile, baseUrl: 'https://b.example.com/v1' }, undefined, store),
    /更换 Base URL/,
  );
  await clearByokProfile(store);
  assert.equal(values.size, 0);
});

test('rejects insecure, credentialed, parameterized, or full completion URLs', () => {
  for (const value of [
    'http://api.example.com/v1',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=secret',
    'https://api.example.com/v1#fragment',
    'https://api.example.com/v1/chat/completions',
  ]) {
    assert.throws(() => normalizeByokBaseUrl(value));
  }
});

test('stored profile parsing fails closed on old, malformed, or unsafe records', () => {
  assert.equal(parseStoredProfile(null), null);
  assert.equal(parseStoredProfile('{bad-json'), null);
  assert.equal(parseStoredProfile(JSON.stringify({ version: 0, profile: DEEPSEEK_BYOK_PRESET })), null);
  assert.equal(parseStoredProfile(JSON.stringify({
    version: 1,
    profile: { ...DEEPSEEK_BYOK_PRESET, baseUrl: 'https://evil.example.com' },
  })), null);
});
