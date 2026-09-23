import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyContextQuestion, createContextPlan } from '../ai/context-plan';
import type { ModelLearningContext } from '../ai/model-learning-context';

function fixture(question: string): ModelLearningContext {
  return {
    mapPurpose: '个人学习图谱。',
    contentPolicy: {
      fingerprint: 'content-policy-v1|learning|plain_language|detailed|outside:on',
      value: {
        version: 1,
        mode: 'learning',
        explanationStyle: 'plain_language',
        detailLevel: 'detailed',
        allowOutsideKnowledge: true,
      },
      instruction: '学习模式；使用说人话风格；详细讲解。',
    },
    originalGoalOrQuestion: '理解 Transformer',
    sourceOrPriorUnderstanding: {
      text: '原文说明：注意力用查询、键和值计算相关性；缩放因子是根号 d_k。',
      truncated: false,
    },
    currentFocus: {
      title: '缩放点积注意力',
      subtitle: '稳定相关性分数',
      importance: 9,
      learningState: 'learning',
      note: { text: 'softmax 前先计算 QK^T / sqrt(d_k)。', kind: 'ai', truncated: false },
    },
    pathFromGoal: [
      { title: '理解 Transformer', importance: 10, learningState: 'learning', relationFromPrevious: null },
      { title: '注意力机制', importance: 9, learningState: 'learning', relationFromPrevious: 'prerequisite' },
      { title: '缩放点积注意力', importance: 9, learningState: 'learning', relationFromPrevious: 'prerequisite' },
    ],
    directConnections: [
      {
        direction: 'towardCurrent',
        title: '向量点积',
        importance: 8,
        learningState: 'mastered',
        relation: 'prerequisite',
        note: { text: '点积衡量两个向量方向上的一致程度。', kind: 'source', truncated: false },
      },
      {
        direction: 'fromCurrent',
        title: '多头注意力',
        importance: 8,
        learningState: 'learning',
        relation: 'support',
        note: { text: '并行执行多个注意力头。', kind: 'ai', truncated: false },
      },
      {
        direction: 'fromCurrent',
        title: '法国大革命年表',
        importance: 4,
        learningState: 'learning',
        relation: 'analogy',
        note: { text: '与本问题无关的测试噪声。', kind: 'learner', truncated: false },
      },
    ],
    recentConversation: [
      { question: 'Q、K、V 是什么？', answer: '它们是查询、键和值。', answerTruncated: false },
      { question: '法国大革命何时发生？', answer: '1789 年。', answerTruncated: false },
    ],
    currentQuestion: { text: question, truncated: false },
    outputLimits: {
      maxNewNodes: 12,
      maxNewEdges: 12,
      allowedRelations: ['prerequisite', 'support', 'analogy', 'evidence', 'counterexample'],
      newNodesOnly: true,
    },
  };
}

test('classifies the five frozen question shapes', () => {
  assert.equal(classifyContextQuestion('缩放点积注意力是什么意思？'), 'definition');
  assert.equal(classifyContextQuestion('为什么公式要除以根号 d_k？'), 'reason_or_formula');
  assert.equal(classifyContextQuestion('我还缺什么前置基础？'), 'prerequisite');
  assert.equal(classifyContextQuestion('比较单头注意力和多头注意力'), 'comparison');
  assert.equal(classifyContextQuestion('只根据原文总结这段资料'), 'source_summary');
});

test('definition does not mechanically attach the whole learning path', () => {
  const plan = createContextPlan(fixture('缩放点积注意力是什么意思？'));
  assert.equal(plan.questionShape, 'definition');
  assert.equal(plan.selected.some((item) => item.kind === 'path'), false);
  assert.equal(plan.modelContext.pathFromGoal.length, 0);
  assert.equal(plan.modelContext.directConnections.some((item) => item.title === '法国大革命年表'), false);
});

test('formula question selects relevant source but drops unrelated branch', () => {
  const plan = createContextPlan(fixture('为什么公式要除以根号 d_k？'));
  assert.equal(plan.modelContext.sourceOrPriorUnderstanding?.text.includes('根号 d_k'), true);
  assert.equal(plan.modelContext.directConnections.some((item) => item.title === '法国大革命年表'), false);
});

test('prerequisite diagnosis selects the path and prerequisite connection', () => {
  const plan = createContextPlan(fixture('理解这里还缺什么前置基础？'));
  assert.ok(plan.modelContext.pathFromGoal.length >= 2);
  assert.equal(plan.modelContext.directConnections.some((item) => item.title === '向量点积'), true);
});

test('comparison selects the named neighboring branch without unrelated memory', () => {
  const plan = createContextPlan(fixture('比较缩放点积注意力和多头注意力的区别'), {
    futureEvidence: [
      {
        id: 'fav-1',
        kind: 'favorite',
        category: 'favorite',
        title: '唐代制度',
        text: '科举制度资料',
        provenance: '全局收藏',
        scopeType: 'global',
        scopeId: 'global',
        scopeLabel: '全局',
      },
    ],
  });
  assert.equal(plan.modelContext.directConnections.some((item) => item.title === '多头注意力'), true);
  assert.equal(plan.selected.some((item) => item.id === 'favorite:fav-1'), false);
});

test('source-bounded summary isolates conversations and future Soul or favorites', () => {
  const plan = createContextPlan(fixture('只根据原文总结这段资料，不要补充外部知识'), {
    futureEvidence: [
      {
        id: 'soul-1',
        kind: 'soul',
        category: 'preference',
        title: '用户偏好',
        text: '加入更多外部知识',
        provenance: '全局 AI 理解',
        scopeType: 'global',
        scopeId: 'global',
        scopeLabel: '全局',
      },
      {
        id: 'fav-1',
        kind: 'favorite',
        category: 'favorite',
        title: '外部论文',
        text: '未出现在原始资料中',
        provenance: '专题收藏',
        scopeType: 'topic',
        scopeId: 'topic-1',
        scopeLabel: '机器学习',
      },
    ],
  });
  assert.equal(plan.questionShape, 'source_summary');
  assert.ok(plan.modelContext.sourceOrPriorUnderstanding);
  assert.equal(plan.modelContext.currentFocus.note, null);
  assert.equal(plan.modelContext.pathFromGoal.length, 0);
  assert.equal(plan.modelContext.directConnections.length, 0);
  assert.equal(plan.modelContext.recentConversation.length, 0);
  assert.equal(plan.selected.some((item) => item.kind === 'soul' || item.kind === 'favorite'), false);
  assert.equal(plan.omitted.some((item) => item.kind === 'soul' && item.omissionReason.includes('无直接关系')), true);
  assert.equal(plan.omitted.some((item) => item.kind === 'favorite' && item.omissionReason.includes('无直接关系')), true);
});

test('summary project keeps source context even when the follow-up question is generic', () => {
  const context = fixture('这是什么意思？');
  context.contentPolicy = {
    fingerprint: 'content-policy-v1|summary|plain_language|detailed|outside:off',
    value: {
      version: 1,
      mode: 'summary',
      explanationStyle: 'plain_language',
      detailLevel: 'detailed',
      allowOutsideKnowledge: false,
    },
    instruction: '总结模式；只按资料回答。',
  };
  const plan = createContextPlan(context);
  assert.equal(plan.questionShape, 'source_summary');
  assert.ok(plan.modelContext.sourceOrPriorUnderstanding);
  assert.equal(plan.selected.some((item) => item.id === 'source' && item.required), true);
  assert.equal(plan.modelContext.recentConversation.length, 0);
});

test('fingerprint is stable and budget omissions are explainable', () => {
  const context = fixture('我还缺什么前置基础？');
  const first = createContextPlan(context, {
    budget: { contextWindowTokens: 1_024, reservedSystemTokens: 128, reservedOutputTokens: 128, safetyTokens: 128 },
  });
  const second = createContextPlan(context, {
    budget: { contextWindowTokens: 1_024, reservedSystemTokens: 128, reservedOutputTokens: 128, safetyTokens: 128 },
  });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^cp1-[a-f0-9]{16}$/u);
  assert.ok(first.selected.every((item) => item.reasons.length > 0));
  assert.ok(first.omitted.every((item) => item.omissionReason.length > 0));
});
