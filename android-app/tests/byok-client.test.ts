import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ByokProviderError,
  requestByokGraphPatch,
  requestByokStructuredJson,
} from '../ai/byok-client';
import type { ByokCredentials } from '../ai/byok-profile';
import type { ExpansionContext } from '../ai/graph-patch';
import type { ModelLearningContext } from '../ai/model-learning-context';

const credentials: ByokCredentials = {
  profile: {
    kind: 'custom',
    label: 'Compatible AI',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-1',
    jsonMode: true,
    tokenLimitField: 'max_tokens',
  },
  apiKey: 'secret-key-123',
};

const context: ExpansionContext = {
  requestId: 'request-1', schemaVersion: 2,
  project: { id: 'project-1', title: '目标', sourceText: '', sourceTextTruncated: false },
  selection: {
    kind: 'node', id: 'node-1', title: '目标', subtitle: '目标', importance: 10, status: 'essential',
    document: { path: '目标.md', title: '目标', body: '# 目标\n\n正文', origin: 'source', truncated: false },
  },
  nearbyNodes: [], learningPath: [], relatedKnowledge: [], recentAnswers: [], prompt: '先学什么', promptTruncated: false,
  contextManifest: { totalCharacters: 4, sections: [
    { key: 'projectSource', label: '项目', characters: 0, truncated: false },
    { key: 'selectionDocument', label: '节点', characters: 0, truncated: false },
    { key: 'learningPath', label: '路径', characters: 0, truncated: false },
    { key: 'relatedKnowledge', label: '相关', characters: 0, truncated: false },
    { key: 'recentAnswers', label: '回答', characters: 0, truncated: false },
    { key: 'prompt', label: '问题', characters: 4, truncated: false },
  ] },
  constraints: { maxNodes: 5, maxEdges: 5, allowedRelations: ['prerequisite'], targetMustBeNewNode: true },
};

const draft = {
  version: 4,
  summary: '先建立入口',
  answerMarkdown: '## 直接回答\n这是针对当前问题的完整回答，而不是一份只有标题的提纲。\n\n## 完整讲解\n这里解释概念之间的因果关系、适用边界以及学习者最容易跳过的推理步骤，保证正文足够独立阅读。\n\n## 例子或推导\n从一个最小具体例子开始，逐步展示输入、变化和结果如何对应。\n\n## 自检\n尝试不用原句复述核心机制，并判断换一个例子后结论是否仍然成立。',
  roots: [{
    title: '入口', subtitle: '基础入口', importance: 9, importanceReason: '这是回答当前问题最关键的入口。', status: 'learning', relationFromParent: 'prerequisite',
    relationDocument: { title: '目标到入口', body: '目标依赖入口，并可通过解释两者关系验证。' },
    document: { title: '入口', body: '# 入口\n\n## 直觉\n这是足够长的教学正文。' }, children: [],
  }, {
    title: '第二要点', subtitle: '补充入口', importance: 7, importanceReason: '它用于补足回答中的第二个关键环节。', status: 'learning', relationFromParent: 'prerequisite',
    relationDocument: { title: '目标到第二要点', body: '第二要点补充当前回答，并可通过复述验证。' },
    document: { title: '第二要点', body: '# 第二要点\n\n## 直觉\n这是第二个足够长的教学正文。' }, children: [],
  }],
};

test('sends one standard compatible request and keeps DeepSeek-only fields out of custom services', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      model: 'model-1',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const result = await requestByokGraphPatch(context, credentials, fetchImpl);
  const body = JSON.parse(String(requestedInit?.body)) as Record<string, unknown>;
  assert.equal(requestedUrl, 'https://api.example.com/v1/chat/completions');
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, 'Bearer secret-key-123');
  assert.equal(body.model, 'model-1');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 4800);
  assert.equal('thinking' in body, false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0].content, /answerMarkdown/);
  assert.match(messages[0].content, /importanceReason/);
  assert.match(messages[0].content, /不可信参考资料/);
  assert.match(messages[0].content, /evidence-reader v3/);
  assert.match(messages[0].content, /来源限定问题宁可说明资料不足/);
  assert.match(messages[0].content, /外层 JSON 字符串必须使用双反斜杠/);
  const sentContext = JSON.parse(messages[1].content) as ModelLearningContext;
  assert.equal(sentContext.originalGoalOrQuestion, '目标');
  assert.equal(sentContext.currentQuestion.text, '先学什么');
  assert.deepEqual(sentContext.recentConversation, []);
  assert.equal('schemaVersion' in sentContext, false);
  assert.equal('nearbyNodes' in sentContext, false);
  assert.equal(result.expansion.patch.nodes[0].clientId, 'n1');
  assert.match(result.expansion.answerMarkdown, /本次生成的知识要点/);
  assert.equal(result.usage?.totalTokens, 50);
});

test('supports newer max_completion_tokens and prompt-only JSON compatibility modes', async () => {
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` } }],
    }), { status: 200 });
  }) as typeof fetch;
  await requestByokGraphPatch(context, {
    ...credentials,
    profile: { ...credentials.profile, jsonMode: false, tokenLimitField: 'max_completion_tokens' },
  }, fetchImpl);
  assert.equal(requestedBody.max_completion_tokens, 4800);
  assert.equal('max_tokens' in requestedBody, false);
  assert.equal('response_format' in requestedBody, false);
});

test('never exposes a provider body or API key in HTTP errors', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ error: { message: 'secret-key-123 is invalid' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;
  await assert.rejects(
    requestByokGraphPatch(context, credentials, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError
      && error.code === 'provider_http_401'
      && !error.message.includes(credentials.apiKey),
  );
});

test('a network-ambiguous request is attempted exactly once and marked unknown', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error('socket closed');
  }) as typeof fetch;
  await assert.rejects(
    requestByokGraphPatch(context, credentials, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError && error.outcomeUnknown,
  );
  assert.equal(calls, 1);
});

test('surfaces a safe provider-output category without exposing returned content', async () => {
  const invalid = structuredClone(draft);
  invalid.roots[0].status = 'definitely-mastered';
  invalid.roots[0].document.body = '# secret-provider-body\n\nshould not appear in an error';
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }],
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    requestByokGraphPatch(context, credentials, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError
      && error.code === 'invalid_provider_output_invalid_status'
      && error.message.includes('节点学习状态')
      && !error.message.includes('secret-provider-body')
      && !error.message.includes(credentials.apiKey),
  );
});

test('structured deep stages use one MiMo JSON request with thinking disabled and no retry', async () => {
  let calls = 0;
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ finish_reason: 'stop', message: { content: '{"version":1,"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }), { status: 200 });
  }) as typeof fetch;
  const result = await requestByokStructuredJson({
    systemPrompt: '只返回 JSON',
    userPayload: { question: '为什么' },
    maxCompletionTokens: 6_000,
  }, {
    ...credentials,
    profile: {
      kind: 'mimo',
      label: 'Xiaomi MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5',
      jsonMode: true,
      tokenLimitField: 'max_completion_tokens',
    },
  }, fetchImpl);
  assert.equal(calls, 1);
  assert.equal(requestedBody.max_completion_tokens, 6_000);
  assert.deepEqual(requestedBody.thinking, { type: 'disabled' });
  assert.deepEqual(requestedBody.response_format, { type: 'json_object' });
  assert.deepEqual(result.value, { version: 1, ok: true });
  assert.equal(result.usage?.totalTokens, 20);
});

test('structured deep stages retain rejected provider text locally for diagnosis', async () => {
  const rejected = '这不是 JSON，但不得出现在用户错误消息里';
  const fetchImpl = (async () => new Response(JSON.stringify({
    model: 'mimo-v2.5',
    choices: [{ finish_reason: 'stop', message: { content: rejected } }],
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    requestByokStructuredJson({
      systemPrompt: '只返回 JSON',
      userPayload: { question: '为什么' },
      maxCompletionTokens: 6_000,
    }, {
      ...credentials,
      profile: {
        kind: 'mimo',
        label: 'Xiaomi MiMo',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5',
        jsonMode: true,
        tokenLimitField: 'max_completion_tokens',
      },
    }, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError
      && error.code === 'invalid_provider_output_json'
      && error.rejectedOutput === rejected
      && error.usage?.totalTokens === 21
      && error.actualModel === 'mimo-v2.5'
      && !error.message.includes(rejected),
  );
});

test('deep input cost guard rejects locally before any provider request', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    requestByokStructuredJson({
      systemPrompt: '只返回 JSON',
      userPayload: { source: '很长的资料'.repeat(100) },
      maxCompletionTokens: 5_000,
      maxInputUtf8Bytes: 64,
    }, credentials, fetchImpl),
    (error: unknown) => error instanceof ByokProviderError
      && error.code === 'deep_input_too_large'
      && !error.outcomeUnknown,
  );
  assert.equal(calls, 0);
});
