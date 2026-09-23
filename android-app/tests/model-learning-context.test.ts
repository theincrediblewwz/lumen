import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExpansionContext } from '../ai/graph-patch';
import { createModelLearningContext } from '../ai/model-learning-context';

const context: ExpansionContext = {
  requestId: 'request-secret-id',
  schemaVersion: 2,
  project: {
    id: 'project-secret-id',
    title: '理解 Transformer',
    sourceText: '从整体结构出发，追溯到已经掌握的数学基础。',
    sourceTextTruncated: false,
  },
  selection: {
    kind: 'node',
    id: 'node-secret-id',
    title: '理解 Transformer',
    subtitle: '目标知识',
    importance: 10,
    status: 'essential',
    document: {
      path: 'knowledge/private/root.md',
      title: '理解 Transformer',
      body: '# 理解 Transformer\n\n## 原始目标或资料\n\n从整体结构出发，追溯到已经掌握的数学基础。\n\n## 学习目标\n\n建立能解释、推导并迁移的理解。',
      origin: 'source',
      truncated: false,
    },
  },
  nearbyNodes: [{ id: 'duplicate-neighbor-id', title: '注意力机制', importance: 9, status: 'essential' }],
  learningPath: [
    { id: 'root-path-id', title: '理解 Transformer', importance: 10, status: 'essential', viaRelation: null },
  ],
  relatedKnowledge: [{
    id: 'related-secret-id',
    title: '注意力机制',
    importance: 9,
    status: 'learning',
    relation: 'prerequisite',
    direction: 'outgoing',
    document: {
      title: '注意力机制',
      body: '# 注意力机制\n\n让每个位置根据相关性选择并聚合信息。',
      origin: 'ai',
      truncated: false,
    },
  }],
  recentAnswers: [{
    question: '注意力是什么？',
    body: '它根据相关性计算加权聚合。',
    source: 'byok',
    createdAt: '2026-07-26T00:00:00.000Z',
    truncated: false,
  }],
  prompt: '缩放点积注意力为什么要除以根号 d？',
  promptTruncated: false,
  contextManifest: {
    totalCharacters: 999,
    sections: [
      { key: 'projectSource', label: '项目', characters: 20, truncated: false },
      { key: 'selectionDocument', label: '节点', characters: 40, truncated: false },
      { key: 'learningPath', label: '路径', characters: 20, truncated: false },
      { key: 'relatedKnowledge', label: '相关', characters: 30, truncated: false },
      { key: 'recentAnswers', label: '回答', characters: 20, truncated: false },
      { key: 'prompt', label: '问题', characters: 20, truncated: false },
    ],
  },
  constraints: {
    maxNodes: 8,
    maxEdges: 8,
    allowedRelations: ['prerequisite', 'support'],
    targetMustBeNewNode: true,
  },
};

test('projects the durable graph context into a complete but non-redundant learning context', () => {
  const projected = createModelLearningContext(context);
  const serialized = JSON.stringify(projected);

  assert.equal(projected.originalGoalOrQuestion, '理解 Transformer');
  assert.match(projected.mapPurpose, /个人学习图谱/);
  assert.equal(projected.sourceOrPriorUnderstanding?.text, context.project.sourceText);
  assert.equal(projected.currentQuestion.text, context.prompt);
  assert.match(projected.currentFocus.note?.text ?? '', /建立能解释、推导并迁移的理解/);
  assert.doesNotMatch(projected.currentFocus.note?.text ?? '', /原始目标或资料/);
  assert.equal(projected.directConnections[0].title, '注意力机制');
  assert.equal(projected.recentConversation[0].question, '注意力是什么？');
  assert.equal(projected.outputLimits.maxNewNodes, 8);

  for (const internalValue of [
    context.requestId,
    context.project.id,
    context.selection.id,
    context.selection.document.path,
    context.relatedKnowledge[0].id,
    context.recentAnswers[0].createdAt,
    'contextManifest',
    'nearbyNodes',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(internalValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});
