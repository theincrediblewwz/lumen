import assert from 'node:assert/strict';
import test from 'node:test';

import { ByokProviderError } from '../ai/byok-client';
import { MIMO_BYOK_PRESET, type ByokCredentials } from '../ai/byok-profile';
import { createBlindPromptOrder, preparePromptLabRequest, PROMPT_LAB_CASES } from '../ai/prompt-lab';
import {
  assertPromptLabCredentials,
  createPromptLabRequestBody,
  PromptLabResponseError,
  requestPromptLabCompletion,
} from '../ai/prompt-lab-client';

const credentials: ByokCredentials = {
  profile: { ...MIMO_BYOK_PRESET },
  apiKey: 'mimo-fixture',
};
const prepared = preparePromptLabRequest(PROMPT_LAB_CASES[0], createBlindPromptOrder('test')[0]);

test('accepts only the exact safe MiMo experiment profile', () => {
  assert.equal(assertPromptLabCredentials(credentials).profile.model, 'mimo-v2.5');
  assert.throws(
    () => assertPromptLabCredentials({ ...credentials, profile: { ...credentials.profile, model: 'other' } }),
    (error: unknown) => error instanceof ByokProviderError && error.code === 'prompt_lab_profile_mismatch',
  );
});

test('keeps all comparison parameters fixed and disables thinking', () => {
  const body = createPromptLabRequestBody(prepared);
  assert.equal(body.model, 'mimo-v2.5');
  assert.equal(body.temperature, 1);
  assert.equal(body.top_p, 0.95);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal('tools' in body, false);
});

test('captures usage, latency-safe metadata and diagnostics without retrying', async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mimo-fixture');
    const content = JSON.stringify({
      answerMarkdown: '这是足够长的直接回答。'.repeat(12),
      keyPoints: [],
    });
    return new Response(JSON.stringify({
      id: 'response-1',
      model: 'mimo-v2.5',
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 25 },
      },
    }), { status: 200 });
  }) as typeof fetch;
  const result = await requestPromptLabCompletion(prepared, credentials, undefined, fetchImpl);
  assert.equal(calls, 1);
  assert.equal(result.providerResponseId, 'response-1');
  assert.equal(result.usage?.cachedInputTokens, 25);
  assert.equal(result.usage?.totalTokens, 150);
  assert.equal(result.estimatedCostCny, 0.0002);
  assert.equal(result.diagnostic.validJson, true);
});

test('marks an ambiguous failure and attempts it exactly once', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error('socket closed');
  }) as typeof fetch;
  await assert.rejects(
    requestPromptLabCompletion(prepared, credentials, undefined, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError && error.outcomeUnknown,
  );
  assert.equal(calls, 1);
});

test('preserves usage and partial output when MiMo reaches the explicit output limit', async () => {
  const partial = '{"answerMarkdown":"未完成';
  const fetchImpl = (async () => new Response(JSON.stringify({
    id: 'response-length',
    model: 'mimo-v2.5',
    choices: [{ finish_reason: 'length', message: { content: partial } }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 4096,
      total_tokens: 4216,
    },
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    requestPromptLabCompletion(prepared, credentials, undefined, fetchImpl),
    (error: unknown) => error instanceof PromptLabResponseError
      && !error.outcomeUnknown
      && error.responseMetadata.finishReason === 'length'
      && error.responseMetadata.usage?.outputTokens === 4096
      && error.responseMetadata.content === partial,
  );
});
