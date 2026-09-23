import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExpansionContext } from '../ai/graph-patch';
import { validateLearningExpansion } from '../ai/graph-patch';
import type { GatewayTokenProvider } from '../ai/gateway-auth';

test('the app gateway client accepts a structured patch over HTTP', async () => {
  process.env.EXPO_PUBLIC_AI_GATEWAY_URL = 'http://127.0.0.1:8787';
  const { requestGraphExpansion } = await import('../ai/gateway-client');
  const context: ExpansionContext = {
    requestId: 'gateway-integration-test',
    schemaVersion: 2,
    project: { id: 'project-test', title: '测试项目', sourceText: '', sourceTextTruncated: false },
    selection: {
      kind: 'node',
      id: 'node-test',
      title: '注意力机制',
      subtitle: '信息选择与聚合',
      importance: 9,
      status: 'learning',
      document: {
        path: '前置/注意力机制.md',
        title: '注意力机制',
        body: '# 注意力机制\n\n测试上下文。',
        origin: 'source',
        truncated: false,
      },
    },
    nearbyNodes: [],
    learningPath: [],
    relatedKnowledge: [],
    recentAnswers: [],
    prompt: '为什么需要缩放？',
    promptTruncated: false,
    contextManifest: { totalCharacters: 8, sections: [
      { key: 'projectSource', label: '项目', characters: 0, truncated: false },
      { key: 'selectionDocument', label: '节点', characters: 0, truncated: false },
      { key: 'learningPath', label: '路径', characters: 0, truncated: false },
      { key: 'relatedKnowledge', label: '相关', characters: 0, truncated: false },
      { key: 'recentAnswers', label: '回答', characters: 0, truncated: false },
      { key: 'prompt', label: '问题', characters: 8, truncated: false },
    ] },
    constraints: {
      maxNodes: 8,
      maxEdges: 12,
      allowedRelations: ['prerequisite', 'evidence', 'analogy', 'support', 'counterexample'],
      targetMustBeNewNode: true,
    },
  };

  let tokenRequests = 0;
  const tokenProvider: GatewayTokenProvider = {
    async getAccessToken(gatewayUrl, options) {
      tokenRequests += 1;
      if (!options?.forceRefresh) return 'force-one-401-before-registration';
      const response = await fetch(`${gatewayUrl}/v1/auth/anonymous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: 'integration-test-install-0001' }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).accessToken;
    },
  };
  const expansion = validateLearningExpansion(await requestGraphExpansion(context, tokenProvider));
  const patch = expansion.patch;
  assert.equal(patch.version, 1);
  assert.equal(patch.nodes.length, 2);
  assert.equal(patch.edges.length, 2);
  assert.match(patch.summary, /Mock provider/);
  assert.match(expansion.answerMarkdown, /Mock 回答/);
  assert.equal(tokenRequests, 2);
});

