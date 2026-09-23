import assert from 'node:assert/strict';
import test from 'node:test';

import { AI_DATA_CONSENT_DISCLOSURE, AI_DATA_CONSENT_VERSION, isAiDataConsentCurrent } from '../ai/ai-data-consent';

test('accepts only the current disclosure version for the same Gateway origin', () => {
  const value = JSON.stringify({
    version: AI_DATA_CONSENT_VERSION,
    gatewayOrigin: 'https://gateway.example.com',
    acceptedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(isAiDataConsentCurrent(value, 'https://gateway.example.com/v1'), true);
  assert.equal(isAiDataConsentCurrent(value, 'https://other.example.com'), false);
});

test('rejects missing, malformed, or older consent records', () => {
  assert.equal(isAiDataConsentCurrent(null, 'https://gateway.example.com'), false);
  assert.equal(isAiDataConsentCurrent('{not-json', 'https://gateway.example.com'), false);
  assert.equal(isAiDataConsentCurrent(JSON.stringify({
    version: '2026-07-23-v3',
    gatewayOrigin: 'https://gateway.example.com',
  }), 'https://gateway.example.com'), false);
});

test('discloses every allowed provider and MiMo handling before sending', () => {
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /DeepSeek/);
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /Xiaomi MiMo/);
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /OpenAI/);
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /IP 地址/);
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /不会将提交内容用于模型训练/);
  assert.match(AI_DATA_CONSENT_DISCLOSURE, /法律要求所需期限/);
});
