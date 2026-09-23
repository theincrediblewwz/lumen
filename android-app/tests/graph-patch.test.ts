import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphPatchValidationError, validateGraphPatch, validateLearningExpansion } from '../ai/graph-patch';

const validPatch = {
  version: 1,
  summary: '生成两个知识点',
  nodes: [
    {
      clientId: 'first-node',
      title: '第一个节点',
      subtitle: '建立直觉',
      importance: 8,
      status: 'learning',
      document: { title: '第一个节点', body: '# 第一个节点\n\n这是足够长的正文。' },
    },
    {
      clientId: 'second-node',
      title: '第二个节点',
      subtitle: '验证边界',
      importance: 7,
      status: 'uncertain',
      document: { title: '第二个节点', body: '# 第二个节点\n\n这是另一份正文。' },
    },
  ],
  edges: [
    {
      clientId: 'edge-first',
      sourceRef: 'selection',
      targetRef: 'first-node',
      relation: 'prerequisite',
      importance: 8,
      document: { title: '关系一', body: '# 关系一\n\n解释为什么需要它。' },
    },
    {
      clientId: 'edge-second',
      sourceRef: 'first-node',
      targetRef: 'second-node',
      relation: 'evidence',
      importance: 7,
      document: { title: '关系二', body: '# 关系二\n\n解释如何验证理解。' },
    },
  ],
};

test('accepts a bounded connected graph patch', () => {
  assert.deepEqual(validateGraphPatch(validPatch), validPatch);
});

test('rejects an edge pointing to an existing selection', () => {
  const patch = structuredClone(validPatch);
  patch.edges[0].targetRef = 'selection';
  assert.throws(() => validateGraphPatch(patch), GraphPatchValidationError);
});

test('rejects unknown references and orphan nodes', () => {
  const patch = structuredClone(validPatch);
  patch.edges = [patch.edges[0]];
  patch.edges[0].sourceRef = 'missing-node';
  assert.throws(() => validateGraphPatch(patch), /sourceRef 不存在|缺少入边/);
});

test('rejects prerequisite cycles among new nodes', () => {
  const patch = structuredClone(validPatch);
  patch.edges.push({
    clientId: 'edge-cycle',
    sourceRef: 'second-node',
    targetRef: 'first-node',
    relation: 'prerequisite',
    importance: 7,
    document: { title: '循环', body: '# 循环关系\n\n这条关系不应被接受。' },
  });
  patch.edges[1].relation = 'prerequisite';
  assert.throws(() => validateGraphPatch(patch), /不能形成环/);
});

test('rejects invalid importance and empty markdown', () => {
  const patch = structuredClone(validPatch);
  patch.nodes[0].importance = 11;
  patch.nodes[0].document.body = '';
  assert.throws(() => validateGraphPatch(patch), /importance|body/);
});

test('requires a complete answer and matching importance reasons for every generated node', () => {
  const expansion = {
    version: 1,
    answerMarkdown: '# 完整回答\n\n## 直接回答\n这是直接结论。\n\n## 完整讲解\n这里解释概念之间的因果关系、适用边界以及学习者最容易跳过的推理步骤，保证正文足够独立阅读。\n\n## 例子或推导\n从一个最小具体例子开始，逐步展示输入、变化和结果。\n\n## 自检\n尝试复述核心机制。',
    keyPoints: [
      { title: '第一个节点', importance: 8, importanceReason: '它是理解当前问题最直接的入口。' },
      { title: '第二个节点', importance: 7, importanceReason: '它用于检查理解能否迁移到新情境。' },
    ],
    patch: validPatch,
  };
  assert.deepEqual(validateLearningExpansion(expansion), expansion);
  const mismatch = structuredClone(expansion);
  mismatch.keyPoints[1].importance = 4;
  assert.throws(() => validateLearningExpansion(mismatch), /keyPoints 与节点不一致/);
  const extraPoint = structuredClone(expansion);
  extraPoint.keyPoints.push({ title: '没有节点的要点', importance: 6, importanceReason: '这个要点没有对应节点，必须拒绝。' });
  assert.throws(() => validateLearningExpansion(extraPoint), /一一对应/);
  const duplicatePoint = structuredClone(expansion);
  duplicatePoint.keyPoints[1].title = duplicatePoint.keyPoints[0].title;
  assert.throws(() => validateLearningExpansion(duplicatePoint), /不能重复|不一致/);
});

test('accepts model-selected frontier sizes from one through eight', () => {
  const answerMarkdown = '# 完整回答\n\n## 直接回答\n这是直接结论。\n\n## 完整讲解\n这里提供足够长的独立解释，说明为什么不同复杂度的问题可以需要不同数量的知识点，而不是机械凑数。\n\n## 例子或推导\n简单问题只需要一个点，复杂问题可以需要更多。\n\n## 自检\n检查每个点是否真正服务当前问题。';
  for (const count of [1, 6, 8]) {
    const nodes = Array.from({ length: count }, (_, index) => ({
      clientId: `node-${index + 1}`,
      title: `节点${index + 1}`,
      subtitle: `第${index + 1}个必要要点`,
      importance: Math.max(1, 9 - index),
      status: 'learning',
      document: { title: `节点${index + 1}`, body: `# 节点${index + 1}\n\n这是足够长的教学正文。` },
    }));
    const edges = nodes.map((node, index) => ({
      clientId: `edge-${index + 1}`,
      sourceRef: 'selection',
      targetRef: node.clientId,
      relation: 'support',
      importance: node.importance,
      document: { title: `关系${index + 1}`, body: `# 关系${index + 1}\n\n解释为什么需要这个要点。` },
    }));
    const expansion = {
      version: 1,
      answerMarkdown,
      keyPoints: nodes.map((node) => ({
        title: node.title,
        importance: node.importance,
        importanceReason: `${node.title}对当前问题有独立且必要的作用。`,
      })),
      patch: { version: 1, summary: `模型选择 ${count} 个要点`, nodes, edges },
    };
    assert.equal(validateLearningExpansion(expansion).patch.nodes.length, count);
  }
});

