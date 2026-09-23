import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertCompatibleDraft,
  parseCompatibleJson,
  parseProviderStructuredJson,
} from '../ai/compatible-chat-draft';
import type { ExpansionContext } from '../ai/graph-patch';

const context: ExpansionContext = {
  requestId: 'byok-test',
  schemaVersion: 2,
  project: { id: 'project-1', title: '理解傅里叶变换', sourceText: '', sourceTextTruncated: false },
  selection: {
    kind: 'node', id: 'selection-1', title: '傅里叶变换', subtitle: '目标', importance: 10, status: 'essential',
    document: { path: '目标.md', title: '傅里叶变换', body: '# 傅里叶变换\n\n目标正文', origin: 'source', truncated: false },
  },
  nearbyNodes: [],
  learningPath: [],
  relatedKnowledge: [],
  recentAnswers: [],
  prompt: '先学什么？',
  promptTruncated: false,
  contextManifest: { totalCharacters: 5, sections: [
    { key: 'projectSource', label: '项目', characters: 0, truncated: false },
    { key: 'selectionDocument', label: '节点', characters: 0, truncated: false },
    { key: 'learningPath', label: '路径', characters: 0, truncated: false },
    { key: 'relatedKnowledge', label: '相关', characters: 0, truncated: false },
    { key: 'recentAnswers', label: '回答', characters: 0, truncated: false },
    { key: 'prompt', label: '问题', characters: 5, truncated: false },
  ] },
  constraints: {
    maxNodes: 8,
    maxEdges: 12,
    allowedRelations: ['prerequisite', 'evidence', 'analogy', 'support', 'counterexample'],
    targetMustBeNewNode: true,
  },
};

const node = (title: string, children: unknown[] = []) => ({
  title,
  subtitle: `${title}副标题`,
  importance: 8,
  importanceReason: `${title}决定能否解释当前问题。`,
  status: 'learning',
  relationFromParent: 'prerequisite',
  relationDocument: { title: `${title}关系`, body: `为什么需要${title}，以及如何验证理解。` },
  document: { title, body: `# ${title}\n\n## 直觉\n这是足够长的教学正文。` },
  children,
});

test('turns nested provider-only nodes into deterministic GraphPatch references', () => {
  const expansion = convertCompatibleDraft({
    version: 4,
    summary: '建立直接入口和更深基础',
    answerMarkdown: answerMarkdown(),
    roots: [node('频率', [node('正弦波')])],
  }, context);
  const patch = expansion.patch;
  assert.deepEqual(patch.nodes.map((item) => item.clientId), ['n1', 'n2']);
  assert.deepEqual(patch.edges.map((item) => [item.clientId, item.sourceRef, item.targetRef]), [
    ['e1', 'selection', 'n1'],
    ['e2', 'n1', 'n2'],
  ]);
  assert.match(expansion.answerMarkdown, /本次生成的知识要点/);
  assert.match(patch.nodes[0].document.body, /重要性 8\/10/);
});

test('requires explicit entry and foundation slots for direct-versus-deeper requests', () => {
  const layered = { ...context, prompt: '请区分直接障碍和更深基础' };
  const expansion = convertCompatibleDraft({
    version: 5,
    summary: '两层路径',
    answerMarkdown: answerMarkdown(),
    entry: node('直接障碍'),
    foundation: node('更深基础'),
    additionalRoots: [],
  }, layered);
  const patch = expansion.patch;
  assert.equal(patch.edges[0].sourceRef, 'selection');
  assert.equal(patch.edges[1].sourceRef, 'n1');
  assert.equal(patch.edges[1].targetRef, 'n2');
});

test('lets the model choose one or more than five nodes within the safety cap', () => {
  const single = convertCompatibleDraft({
    version: 4,
    summary: '一个要点已经足够',
    answerMarkdown: answerMarkdown(),
    roots: [node('唯一必要要点')],
  }, context);
  assert.equal(single.patch.nodes.length, 1);

  const broad = convertCompatibleDraft({
    version: 4,
    summary: '复杂问题需要六个互补要点',
    answerMarkdown: answerMarkdown(),
    roots: Array.from({ length: 6 }, (_, index) => node(`要点${index + 1}`)),
  }, context);
  assert.equal(broad.patch.nodes.length, 6);
  assert.equal(broad.keyPoints.length, 6);
});

test('normalizes safe compatible-model drift without inventing graph meaning', () => {
  const looseLeaf = {
    ...node('入口'),
    importance: '8',
    status: '学习中',
    relationFromParent: '前置知识',
  } as Record<string, unknown>;
  delete looseLeaf.children;
  const expansion = convertCompatibleDraft({
    version: '4',
    summary: '兼容格式漂移',
    answerMarkdown: answerMarkdown(),
    roots: [looseLeaf],
  }, context);
  assert.equal(expansion.patch.nodes[0].importance, 8);
  assert.equal(expansion.patch.nodes[0].status, 'learning');
  assert.equal(expansion.patch.edges[0].relation, 'prerequisite');

  const layered = { ...context, prompt: '请区分直接障碍和更深基础' };
  assert.equal(convertCompatibleDraft({
    version: '5',
    summary: '缺省附加节点列表',
    answerMarkdown: answerMarkdown(),
    entry: node('入口'),
    foundation: node('基础'),
  }, layered).patch.nodes.length, 2);
});

test('repairs JSON control escapes inside Markdown math before storing answers and node documents', () => {
  const damagedTheta = `$${'\t'}heta$`;
  const damagedBeta = `$${'\b'}eta$`;
  const damagedFraction = `$${'\f'}rac{1}{2}$`;
  const damagedRho = `$${'\r'}ho$`;
  const damagedNabla = `$${'\n'}abla f$`;
  const damagedNode = node('复数辐角');
  damagedNode.document.body = `# 复数辐角\n\n## 直觉\n当 ${damagedTheta} 增大时，复数沿单位圆旋转。正文\t缩进保持原样。`;
  const expansion = convertCompatibleDraft({
    version: 4,
    summary: '解释复数辐角',
    answerMarkdown: `${answerMarkdown()}\n\n用 ${damagedTheta}、${damagedBeta}、${damagedFraction}、${damagedRho} 和 ${damagedNabla} 检查控制转义。`,
    roots: [damagedNode],
  }, context);

  assert.match(expansion.answerMarkdown, /\$\\theta\$/u);
  assert.match(expansion.answerMarkdown, /\$\\beta\$/u);
  assert.match(expansion.answerMarkdown, /\$\\frac\{1\}\{2\}\$/u);
  assert.match(expansion.answerMarkdown, /\$\\rho\$/u);
  assert.match(expansion.answerMarkdown, /\$\\nabla f\$/u);
  assert.equal(expansion.answerMarkdown.includes('\t'), false);
  assert.match(expansion.patch.nodes[0].document.body, /\$\\theta\$/u);
  assert.match(expansion.patch.nodes[0].document.body, /正文\t缩进保持原样/u);
});

function answerMarkdown() {
  return '## 直接回答\n这是针对当前问题的完整回答，而不是一份只有标题的提纲。\n\n## 完整讲解\n这里解释概念之间的因果关系、适用边界以及学习者最容易跳过的推理步骤，保证正文足够独立阅读。\n\n## 例子或推导\n从一个最小具体例子开始，逐步展示输入、变化和结果如何对应。\n\n## 自检\n尝试不用原句复述核心机制，并判断换一个例子后结论是否仍然成立。';
}

test('accepts a single exact JSON fence but rejects malformed or disallowed relations', () => {
  assert.deepEqual(parseCompatibleJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseCompatibleJson('before {"ok":true}'));
  assert.throws(() => convertCompatibleDraft({ version: 4, summary: '非法', answerMarkdown: 'x'.repeat(130), roots: [
    { ...node('越权'), relationFromParent: 'deletes-evidence' },
  ] }, context));
});

test('deep provider parser repairs transport drift before strict stage validation', () => {
  const wrapped = `Here is the requested object:
\`\`\`json
{
  "answer": "公式 $\\sqrt{d_k}$ 和 $\\text{softmax}$",
  "lines": "第一行
第二行",
}
\`\`\`
Done.`;
  assert.deepEqual(parseProviderStructuredJson(wrapped), {
    answer: '公式 $\\sqrt{d_k}$ 和 $\\text{softmax}$',
    lines: '第一行\n第二行',
  });
  assert.throws(() => parseProviderStructuredJson('not an object at all'));
});
