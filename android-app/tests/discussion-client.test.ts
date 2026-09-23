import assert from 'node:assert/strict';
import test from 'node:test';
import { streamDiscussion } from '../ai/discussion-client';
import type { ByokCredentials } from '../ai/byok-profile';

const credentials: ByokCredentials = { profile: { kind: 'custom', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', jsonMode: false, tokenLimitField: 'max_tokens' }, apiKey: 'fixture-key' };
const messages = [{ role: 'user' as const, content: '解释公式' }];
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\r\n\r\n`;
const stop = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
function response(chunks: Uint8Array[], close = true) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else if (close) controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const bytes = (value: string) => new TextEncoder().encode(value);

test('fragmented UTF-8 and SSE frames preserve Chinese, emoji, Markdown and LaTeX exactly', async () => {
  const text = '# 中文 🌍\n\n$$\\frac{1}{2}$$\n\n`<标签>`'; const payload = bytes(delta(text) + stop + 'data: [DONE]\n\n');
  const chunks = Array.from({ length: Math.ceil(payload.length / 2) }, (_, index) => payload.slice(index * 2, index * 2 + 2));
  let calls = 0; let received = '';
  const result = await streamDiscussion(credentials, messages, { onText: text => { received = text; }, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://fixture.invalid/v1/chat/completions'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true); assert.equal(body.max_tokens, 6000);
    return response(chunks);
  } });
  assert.equal(calls, 1); assert.equal(received, text); assert.deepEqual(result, { text, model: 'fixture-model' });
});

test('[DONE] finishes without waiting for server EOF and ignores subsequent bytes', { timeout: 1000 }, async () => {
  let calls = 0;
  const result = await streamDiscussion(credentials, messages, { onText: () => {}, timeoutMs: 100, fetchImpl: async () => {
    calls++; return response([bytes(delta('完整回答') + 'data: [DONE]\n\n' + delta('不应拼接'))], false);
  } });
  assert.equal(result.text, '完整回答'); assert.equal(calls, 1);
});

test('premature EOF, malformed frames, provider errors and token truncation preserve partial text and never retry', async () => {
  const endings = ['', 'data: {broken}\n\n', 'data: {"error":{"message":"synthetic-secret"}}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'];
  for (const ending of endings) {
    let calls = 0; let partial = '';
    await assert.rejects(streamDiscussion(credentials, messages, { onText: value => { partial = value; }, fetchImpl: async () => { calls++; return response([bytes(delta('已收到') + ending)]); } }), error => error instanceof Error && !error.message.includes('synthetic-secret'));
    assert.equal(partial, '已收到'); assert.equal(calls, 1);
  }
});

test('cancellation interrupts a reader that has not closed and does not send another request', { timeout: 1000 }, async () => {
  let calls = 0; let partial = ''; const controller = new AbortController();
  const result = streamDiscussion(credentials, messages, { signal: controller.signal, onText: text => { partial = text; setTimeout(() => controller.abort(), 1); }, fetchImpl: async () => { calls++; return response([bytes(delta('收到的原文'))], false); } });
  await assert.rejects(result, /停止|超时/); assert.equal(partial, '收到的原文'); assert.equal(calls, 1);
});

test('already cancelled, oversized and empty requests never call the provider', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const fetchImpl = async () => { calls++; return response([]); };
  await assert.rejects(streamDiscussion(credentials, messages, { signal: controller.signal, onText: () => {}, fetchImpl }), /停止/);
  await assert.rejects(streamDiscussion(credentials, [], { onText: () => {}, fetchImpl }), /上限/);
  await assert.rejects(streamDiscussion(credentials, [{ role: 'user', content: 'x'.repeat(100001) }], { onText: () => {}, fetchImpl }), /上限/);
  assert.equal(calls, 0);
});

test('hung fetch times out even when implementation ignores AbortSignal; private error text is never surfaced', { timeout: 1000 }, async () => {
  let calls = 0;
  await assert.rejects(streamDiscussion(credentials, messages, { onText: () => {}, timeoutMs: 10, fetchImpl: async () => { calls++; return new Promise(() => {}); } }), /超时/);
  assert.equal(calls, 1);
  await assert.rejects(streamDiscussion(credentials, messages, { onText: () => {}, fetchImpl: async () => { throw new Error('synthetic-private-token'); } }), error => error instanceof Error && !error.message.includes('synthetic-private-token') && /不会自动重试/.test(error.message));
});

test('HTTP error bodies are not read and failures never retry', async () => {
  let calls = 0;
  await assert.rejects(streamDiscussion(credentials, messages, { onText: () => {}, fetchImpl: async () => { calls++; return new Response('synthetic-private-token', { status: 429 }); } }), error => error instanceof Error && /HTTP 429/.test(error.message) && !error.message.includes('synthetic-private-token'));
  assert.equal(calls, 1);
});

test('answer size limit stops receiving and preserves the previously accepted text', async () => {
  let calls = 0; let partial = '';
  await assert.rejects(streamDiscussion(credentials, messages, { onText: value => { partial = value; }, fetchImpl: async () => { calls++; return response([bytes(delta('已保留')), bytes(delta('x'.repeat(1000001))), bytes('data: [DONE]\n\n')]); } }), /上限/);
  assert.equal(partial, '已保留'); assert.equal(calls, 1);
});

test('invalid UTF-8 rejects instead of silently changing the received text', async () => {
  let calls = 0;
  await assert.rejects(streamDiscussion(credentials, messages, { onText: () => {}, fetchImpl: async () => { calls++; return response([Uint8Array.from([0xc0, 0xaf])]); } }));
  assert.equal(calls, 1);
});
