import assert from 'node:assert/strict';
import test from 'node:test';

import { AiGatewayError, normalizeGatewayUrl, gatewayRequestContext } from '../ai/gateway-client';
import type { ExpansionContext } from '../ai/graph-patch';

test('strict legacy gateways receive no new field when knowledge is disabled; authorized versions remain intact', () => {
  const context = { project: { id: 'board', knowledgeReferences: [] } } as unknown as ExpansionContext;
  assert.equal('knowledgeReferences' in gatewayRequestContext(context).project, false);
  assert.deepEqual(context.project.knowledgeReferences, []);
  context.project.knowledgeReferences = [{ entryId: 'own', revisionId: 'old-version', title: '理解', kind: 'understanding', excerpt: '我的观点', source: '', authorship: 'user', truncated: false }];
  assert.deepEqual(gatewayRequestContext(context).project.knowledgeReferences, context.project.knowledgeReferences);
});

test('accepts an exact HTTPS origin and approved local emulator origins', () => {
  assert.equal(normalizeGatewayUrl('https://gateway.example.com/'), 'https://gateway.example.com');
  assert.equal(normalizeGatewayUrl('http://10.0.2.2:8787'), 'http://10.0.2.2:8787');
});

test('rejects insecure remote URLs and URL components outside the origin', () => {
  const values = [
    'http://gateway.example.com',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com/path',
    'https://gateway.example.com?token=bad',
    'https://gateway.example.com/#fragment',
  ];
  for (const value of values) {
    assert.throws(
      () => normalizeGatewayUrl(value),
      (error: unknown) => error instanceof AiGatewayError
        && ['insecure_gateway_url', 'invalid_gateway_origin'].includes(error.code),
    );
  }
});
