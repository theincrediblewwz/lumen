import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BYOK_DATA_CONSENT_VERSION,
  getByokDisclosure,
  getByokDestination,
  isByokDataConsentCurrent,
} from '../ai/byok-data-consent';
import type { ByokProfile } from '../ai/byok-profile';

const profile: ByokProfile = {
  kind: 'custom',
  label: 'Example AI',
  baseUrl: 'https://api.example.com/v1',
  model: 'model-1',
  jsonMode: true,
  tokenLimitField: 'max_tokens',
};

test('binds direct-send consent to both endpoint and model', () => {
  const value = JSON.stringify({
    version: BYOK_DATA_CONSENT_VERSION,
    destination: getByokDestination(profile),
    acceptedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(isByokDataConsentCurrent(value, profile), true);
  assert.equal(isByokDataConsentCurrent(value, { ...profile, model: 'model-2' }), false);
  assert.equal(isByokDataConsentCurrent(value, { ...profile, baseUrl: 'https://other.example.com/v1' }), false);
});

test('discloses the exact custom destination and avoids claiming a verified provider policy', () => {
  const disclosure = getByokDisclosure(profile);
  assert.match(disclosure, /Example AI/);
  assert.match(disclosure, /https:\/\/api\.example\.com\/v1/);
  assert.match(disclosure, /model-1/);
  assert.match(disclosure, /由你选择的服务商决定/);
});
