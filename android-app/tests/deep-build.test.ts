import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeDeepBuildStage,
  createDeepBuildRun,
  DeepBuildValidationError,
  failDeepBuildStage,
  fingerprintDeepBuildArtifact,
  getNextDeepBuildStage,
  selectExpansionQualityPath,
  startDeepBuildStage,
  validateGraphCompilation,
  validateKnowledgeDossier,
  validateTeachingPlan,
  type GraphCompilation,
  type KnowledgeDossier,
  type TeachingPlan,
} from '../ai/deep-build';
import {
  composeGraphCompilation,
  normalizeGraphStructuralDraft,
  normalizeKnowledgeDossierDraft,
  normalizeTeachingPlanDraft,
} from '../ai/deep-build-prompts';

test('new goals default to deep while ordinary node questions remain quick', () => {
  assert.equal(selectExpansionQualityPath('new_project'), 'deep');
  assert.equal(selectExpansionQualityPath('node_question'), 'quick');
  assert.equal(selectExpansionQualityPath('node_question', 'deep'), 'deep');
  assert.equal(selectExpansionQualityPath('new_project', 'quick'), 'quick');
});

test('validates a complete dossier and keeps source-bounded claims traceable', () => {
  const dossier = validateKnowledgeDossier(dossierFixture('source_bounded'));
  assert.equal(dossier.items.length, 3);
  assert.match(fingerprintDeepBuildArtifact('kd1', dossier), /^kd1-[a-f0-9]{16}$/u);
  assert.throws(
    () => validateKnowledgeDossier({
      ...dossierFixture('source_bounded'),
      items: [{ ...dossierFixture('source_bounded').items[0], sourceRefs: [] }],
    }),
    (error: unknown) => error instanceof DeepBuildValidationError
      && error.issues.some((issue) => issue.includes('sourceRefs')),
  );
});

test('does not let AI inference silently become assumed learner knowledge', () => {
  const dossier = validateKnowledgeDossier(dossierFixture());
  const input = teachingPlanFixture(dossier);
  const plan = validateTeachingPlan(input, dossier);
  assert.equal(plan.learnerAssumptions[0].action, 'diagnose');
  assert.throws(
    () => validateTeachingPlan({
      ...input,
      learnerAssumptions: [{
        concept: '矩阵乘法',
        state: 'pending_ai_inference',
        action: 'assume',
        provenance: 'AI 根据一次对话推测',
      }],
    }, dossier),
    (error: unknown) => error instanceof DeepBuildValidationError
      && error.issues.some((issue) => issue.includes('必须先 diagnose')),
  );
});

test('source-bounded teaching plan rejects outside knowledge', () => {
  const dossier = validateKnowledgeDossier(dossierFixture('source_bounded'));
  assert.throws(
    () => validateTeachingPlan({
      ...teachingPlanFixture(dossier),
      outsideKnowledgeUsed: true,
    }, dossier),
    (error: unknown) => error instanceof DeepBuildValidationError
      && error.issues.some((issue) => issue.includes('不能引入外部知识')),
  );
});

test('graph compiler preserves the adapted answer and covers every dossier item', () => {
  const dossier = validateKnowledgeDossier(dossierFixture());
  const teachingPlan = validateTeachingPlan(teachingPlanFixture(dossier), dossier);
  const compilation = validateGraphCompilation(graphCompilationFixture(dossier, teachingPlan), dossier, teachingPlan);
  assert.equal(compilation.learningExpansion.answerMarkdown, teachingPlan.adaptedAnswerMarkdown);
  assert.equal(compilation.coverage.length, dossier.items.length);
  assert.throws(
    () => validateGraphCompilation({
      ...graphCompilationFixture(dossier, teachingPlan),
      learningExpansion: {
        ...graphCompilationFixture(dossier, teachingPlan).learningExpansion,
        answerMarkdown: `${teachingPlan.adaptedAnswerMarkdown}\n\n第三轮擅自增加的结论。`,
      },
    }, dossier, teachingPlan),
    (error: unknown) => error instanceof DeepBuildValidationError
      && error.issues.some((issue) => issue.includes('不能改写')),
  );
});

test('graph compiler rejects missing coverage and invented node references', () => {
  const dossier = validateKnowledgeDossier(dossierFixture());
  const teachingPlan = validateTeachingPlan(teachingPlanFixture(dossier), dossier);
  const valid = graphCompilationFixture(dossier, teachingPlan);
  assert.throws(
    () => validateGraphCompilation({
      ...valid,
      coverage: [
        { ...valid.coverage[1], nodeTitle: '不存在的节点' },
      ],
    }, dossier, teachingPlan),
    (error: unknown) => error instanceof DeepBuildValidationError
      && error.issues.some((issue) => issue.includes('实际生成的节点'))
      && error.issues.some((issue) => issue.includes('没有覆盖决策')),
  );
});

test('local graph composition locks the teaching answer and only accepts a structural draft', () => {
  const dossier = validateKnowledgeDossier(dossierFixture());
  const teachingPlan = validateTeachingPlan(teachingPlanFixture(dossier), dossier);
  const full = graphCompilationFixture(dossier, teachingPlan);
  const structuralDraft = {
    version: 1,
    dossierFingerprint: full.dossierFingerprint,
    teachingPlanFingerprint: full.teachingPlanFingerprint,
    summary: full.learningExpansion.patch.summary,
    nodes: full.learningExpansion.patch.nodes.map((node) => ({
      ...node,
      importanceReason: full.learningExpansion.keyPoints
        .find((point) => point.title === node.title)?.importanceReason,
    })),
    edges: full.learningExpansion.patch.edges,
    coverage: full.coverage,
    answerMarkdown: '第三阶段试图覆盖回答，但本地不应读取此字段。',
  };
  const composed = composeGraphCompilation(structuralDraft, dossier, teachingPlan);
  assert.equal(composed.learningExpansion.answerMarkdown, teachingPlan.adaptedAnswerMarkdown);
  assert.equal(composed.learningExpansion.keyPoints.length, structuralDraft.nodes.length);
});

test('provider adapter normalizes harmless MiMo schema drift before strict persistence validation', () => {
  const expectedDossier = dossierFixture();
  const dossier = validateKnowledgeDossier(normalizeKnowledgeDossierDraft({
    version: '1',
    goal: expectedDossier.goal,
    answerMarkdown: expectedDossier.canonicalAnswerMarkdown,
    keyPoints: expectedDossier.items.map((item) => ({
      name: item.title,
      role: item.role === 'concept' ? '核心概念' : item.role === 'prerequisite' ? '前置知识' : '常见误区',
      description: item.body,
    })),
    notes: '覆盖目标机制与必要的学习边界。',
  }, {
    sourceBoundary: 'learning_open',
    goal: expectedDossier.goal,
  }));
  assert.deepEqual(dossier.items.map((item) => item.id), ['item-1', 'item-2', 'item-3']);

  const expectedPlan = {
    ...teachingPlanFixture(dossier),
    teachingSequence: [
      {
        title: '先建立数值尺度直觉',
        purpose: '避免一开始被完整公式和符号压住。',
        dossierItemIds: [dossier.items[1].id, dossier.items[2].id],
      },
      {
        title: '回到缩放点积公式',
        purpose: '把前面的数值机制重新连接到目标概念。',
        dossierItemIds: [dossier.items[0].id],
      },
    ],
  };
  const plan = validateTeachingPlan(normalizeTeachingPlanDraft({
    ...expectedPlan,
    version: '1',
    dossierFingerprint: 'model-copied-the-wrong-value',
    adaptedAnswerMarkdown: undefined,
    answerMarkdown: expectedPlan.adaptedAnswerMarkdown,
    learnerAssumptions: undefined,
    diagnosticQuestions: undefined,
    styleDecision: undefined,
    styleNotes: expectedPlan.styleDecision,
  }, dossier), dossier);
  assert.equal(plan.dossierFingerprint, fingerprintDeepBuildArtifact('kd1', dossier));

  const fullFixture = graphCompilationFixture(dossier, plan);
  const full = {
    ...fullFixture,
    coverage: fullFixture.coverage.map((item, index) => ({
      ...item,
      dossierItemId: dossier.items[index].id,
    })),
  };
  const structural = {
    version: '1',
    dossierFingerprint: 'wrong',
    teachingPlanFingerprint: 'wrong',
    summary: full.learningExpansion.patch.summary,
    nodes: full.learningExpansion.patch.nodes.map((node, index) => ({
      ...node,
      clientId: index === 0 ? '中文标识' : node.clientId,
      importanceReason: full.learningExpansion.keyPoints[index].importanceReason,
    })),
    edges: full.learningExpansion.patch.edges.map((edge, index) => ({
      ...edge,
      clientId: index === 0 ? '边标识' : edge.clientId,
      targetRef: index === 0 ? full.learningExpansion.patch.nodes[0].title : edge.targetRef,
      sourceRef: index === 1 ? full.learningExpansion.patch.nodes[0].title : edge.sourceRef,
    })),
    coverage: full.coverage,
  };
  const compilation = composeGraphCompilation(
    normalizeGraphStructuralDraft(structural, dossier, plan),
    dossier,
    plan,
  );
  assert.equal(compilation.learningExpansion.patch.nodes[0].clientId, 'node-1');
  assert.equal(compilation.learningExpansion.patch.edges[0].targetRef, 'node-1');
});

test('graph adapter repairs harmless nesting, aliases, missing incoming edges, and incomplete coverage', () => {
  const dossier = validateKnowledgeDossier(dossierFixture());
  const teachingPlan = validateTeachingPlan(teachingPlanFixture(dossier), dossier);
  const normalized = normalizeGraphStructuralDraft({
    version: '1',
    learningExpansion: {
      patch: {
        summary: '从数值尺度切入理解注意力机制。',
        nodes: [
          {
            id: '中文节点',
            name: '缩放点积',
            description: '先理解为什么点积结果需要除以维度的平方根。',
            priority: '9',
            status: '关键',
            importanceReason: '这是理解 softmax 数值稳定性的直接入口。',
            documentMarkdown: '# 缩放点积\n\n点积除以维度平方根，可以避免维度升高后分数绝对值过大。',
          },
        ],
        edges: [],
      },
    },
    coverage: [
      {
        itemTitle: '缩放点积',
        disposition: '节点',
        nodeId: '中文节点',
        reason: '该条目适合作为可以继续追问和展开的独立节点。',
      },
    ],
  }, dossier, teachingPlan);
  const compilation = composeGraphCompilation(normalized, dossier, teachingPlan);
  assert.equal(compilation.learningExpansion.patch.nodes[0].clientId, 'node-1');
  assert.equal(compilation.learningExpansion.patch.nodes[0].importance, 9);
  assert.equal(compilation.learningExpansion.patch.edges[0].sourceRef, 'selection');
  assert.equal(compilation.learningExpansion.patch.edges[0].targetRef, 'node-1');
  assert.equal(compilation.coverage.length, dossier.items.length);
  assert.equal(compilation.coverage[0].disposition, 'node');
  assert.equal(compilation.coverage[1].disposition, 'deferred');
});

test('three-stage adapter accepts wrapped prose-first MiMo output without weakening final validation', () => {
  const longAnswer = [
    '# 为什么要缩放点积',
    '注意力分数来自查询向量与键向量的点积。维度增大时，点积的波动范围也会变大，softmax 更容易进入过饱和区域。',
    '缩放并不是为了改变哪个位置更重要，而是把进入 softmax 的数值尺度拉回更容易比较和学习的范围。',
    '可以先比较一个低维例子，再观察维度增加后分数差距如何被指数函数放大，最后回到公式检查变量意义。',
  ].join('\n\n');
  const dossier = validateKnowledgeDossier(normalizeKnowledgeDossierDraft({
    data: {
      learningGoal: '理解缩放点积注意力',
      fullAnswer: longAnswer,
      knowledgeItems: [
        {
          name: '点积的尺度',
          type: '前置知识',
          explanation: '独立分量累加后，维度越高，点积的典型绝对值通常越大。',
        },
        'Softmax 会把较大的分数差距进一步放大，因此需要先控制输入尺度。',
      ],
      limitations: '这里解释数值尺度和学习稳定性的关系，不把缩放误说成概率校准。',
    },
  }, {
    sourceBoundary: 'learning_open',
    goal: '理解缩放点积注意力',
  }));
  assert.equal(dossier.items.length, 2);
  assert.ok(dossier.items.some((item) => item.role === 'concept'));
  assert.ok(dossier.canonicalAnswerMarkdown.length >= 200);

  const teachingPlan = validateTeachingPlan(normalizeTeachingPlanDraft({
    result: {
      answer: longAnswer,
      assumptions: [{
        title: 'Softmax',
        status: '待判断',
        action: '视为已知',
        reason: '用户只在图谱中见过这个词，还没有完成自检。',
      }],
      steps: [{
        name: '先看点积尺度',
        reason: '先建立数值直觉，再回到完整公式。',
        items: ['点积的尺度'],
      }],
      checkQuestions: ['如果不缩放，维度增大时 softmax 输入会怎样变化？'],
      method: '先说人话，再用最小公式验证直觉。',
    },
  }, dossier), dossier);
  assert.equal(teachingPlan.learnerAssumptions[0].state, 'pending_ai_inference');
  assert.equal(teachingPlan.learnerAssumptions[0].action, 'diagnose');
  assert.deepEqual(teachingPlan.teachingSequence[0].dossierItemIds, [dossier.items[0].id]);

  const normalizedGraph = normalizeGraphStructuralDraft({
    data: {
      knowledgeGraph: {
        summary: '从数值尺度和 softmax 饱和两个入口继续展开。',
        topics: [{
          name: '点积方差随维度增长',
          description: '先理解为什么高维点积更容易出现较大的绝对值。',
          priority: 9,
          status: '核心',
          markdown: '# 点积方差随维度增长\n\n独立分量的乘积累加后，方差会随维度增长。',
        }],
        relationships: [{
          from: '当前节点',
          to: '点积方差随维度增长',
          type: '前置知识',
          priority: 9,
          reason: '这是解释缩放因子来源的直接前置。',
        }],
      },
      coverageDecisions: [{
        itemTitle: '点积的尺度',
        action: '节点',
        nodeRef: '点积方差随维度增长',
        rationale: '该条目值得继续展开。',
      }],
    },
  }, dossier, teachingPlan);
  const compilation = composeGraphCompilation(normalizedGraph, dossier, teachingPlan);
  assert.equal(compilation.learningExpansion.patch.nodes.length, 1);
  assert.equal(compilation.learningExpansion.patch.edges[0].sourceRef, 'selection');
  assert.equal(compilation.coverage.length, dossier.items.length);
});

test('state machine enforces ordered stages and explicit manual retry', () => {
  let run = createDeepBuildRun({
    runId: 'deep-1',
    contextFingerprint: 'cp1-1234567890abcdef',
    sourceBoundary: 'learning_open',
    now: '2026-07-29T09:00:00+08:00',
  });
  assert.equal(getNextDeepBuildStage(run), 'knowledge_dossier');
  assert.throws(
    () => startDeepBuildStage(run, 'teaching_plan', 'request-2', '2026-07-29T09:00:01+08:00'),
    /当前不能启动/u,
  );
  run = startDeepBuildStage(run, 'knowledge_dossier', 'request-1', '2026-07-29T09:00:01+08:00');
  run = failDeepBuildStage(run, 'knowledge_dossier', {
    code: 'provider_503',
    chargeState: 'known',
    now: '2026-07-29T09:00:02+08:00',
  });
  assert.throws(
    () => startDeepBuildStage(run, 'knowledge_dossier', 'request-1b', '2026-07-29T09:00:03+08:00'),
    /用户明确重试/u,
  );
  run = startDeepBuildStage(
    run,
    'knowledge_dossier',
    'request-1b',
    '2026-07-29T09:00:03+08:00',
    { manualRetry: true },
  );
  run = completeDeepBuildStage(run, 'knowledge_dossier', 'kd1-1234567890abcdef', '2026-07-29T09:00:04+08:00');
  assert.equal(getNextDeepBuildStage(run), 'teaching_plan');
  assert.equal(run.status, 'ready');
});

test('state machine reaches success only after all three artifacts finish', () => {
  let run = createDeepBuildRun({
    runId: 'deep-complete',
    contextFingerprint: 'cp1-1234567890abcdef',
    sourceBoundary: 'learning_open',
    now: '2026-07-29T09:00:00+08:00',
  });
  const stages = [
    ['knowledge_dossier', 'request-1', 'kd1-1234567890abcdef'],
    ['teaching_plan', 'request-2', 'tp1-1234567890abcdef'],
    ['graph_compilation', 'request-3', 'gc1-1234567890abcdef'],
  ] as const;
  stages.forEach(([stage, requestId, artifactFingerprint], index) => {
    run = startDeepBuildStage(run, stage, requestId, `2026-07-29T09:00:0${index + 1}+08:00`);
    run = completeDeepBuildStage(
      run,
      stage,
      artifactFingerprint,
      `2026-07-29T09:00:1${index + 1}+08:00`,
    );
  });
  assert.equal(run.status, 'succeeded');
  assert.equal(getNextDeepBuildStage(run), null);
});

test('unknown-charge stage is terminal and cannot be replayed', () => {
  let run = createDeepBuildRun({
    runId: 'deep-unknown',
    contextFingerprint: 'cp1-1234567890abcdef',
    sourceBoundary: 'learning_open',
    now: '2026-07-29T09:00:00+08:00',
  });
  run = startDeepBuildStage(run, 'knowledge_dossier', 'request-1', '2026-07-29T09:00:01+08:00');
  run = failDeepBuildStage(run, 'knowledge_dossier', {
    code: 'network_ambiguous',
    chargeState: 'unknown',
    now: '2026-07-29T09:00:02+08:00',
  });
  assert.equal(run.status, 'unknown_charge');
  assert.equal(getNextDeepBuildStage(run), null);
  assert.throws(
    () => startDeepBuildStage(
      run,
      'knowledge_dossier',
      'request-2',
      '2026-07-29T09:00:03+08:00',
      { manualRetry: true },
    ),
    /当前不能启动/u,
  );
});

function dossierFixture(sourceBoundary: KnowledgeDossier['sourceBoundary'] = 'learning_open') {
  const sourceRefs = sourceBoundary === 'source_bounded' ? ['source:item-1#paragraph-2'] : [];
  return {
    version: 1 as const,
    sourceBoundary,
    goal: '理解缩放点积注意力',
    canonicalAnswerMarkdown: [
      '# 缩放点积注意力',
      '',
      '缩放点积注意力先用查询与键的点积衡量相关性，再除以 $\\sqrt{d_k}$，避免维度升高后分数绝对值变大，使 softmax 过早饱和。',
      '',
      '理解它需要同时看到向量点积、方差随维度累积以及 softmax 对大数值的敏感性。缩放不是装饰，而是稳定训练和梯度的重要条件。',
      '',
      '最小例子可以比较未缩放和缩放后的两个分数，观察概率分布是否过分接近 0 与 1。',
      '',
      '教学时应先解释数值尺度，再进入概率分布和梯度，最后才回到完整注意力公式。这样学习者看到的不只是符号操作，也知道每一步解决了什么问题。',
    ].join('\n'),
    items: [
      {
        id: 'scaled-dot-product',
        role: 'concept' as const,
        title: '缩放点积',
        body: '点积结果除以维度平方根，使不同维度下的数值尺度更稳定。',
        sourceRefs,
      },
      {
        id: 'dot-product-variance',
        role: 'prerequisite' as const,
        title: '点积方差',
        body: '理解独立分量乘积求和后方差如何随维度增长。',
        sourceRefs,
      },
      {
        id: 'softmax-saturation',
        role: 'misconception' as const,
        title: 'softmax 饱和',
        body: '误以为缩放只影响概率大小，而不会影响梯度和训练稳定性。',
        sourceRefs,
      },
    ],
    completenessNotes: '覆盖了定义、直接前置、数值机制、常见误区和最小例子。',
  };
}

function teachingPlanFixture(dossier: KnowledgeDossier) {
  return {
    version: 1 as const,
    dossierFingerprint: fingerprintDeepBuildArtifact('kd1', dossier),
    adaptedAnswerMarkdown: [
      '# 为什么要缩放',
      '',
      '先抓住一句话：维度越高，点积通常越大；除以 $\\sqrt{d_k}$ 是把它拉回稳定尺度。',
      '',
      '你可以先把每一维看作一次小贡献。许多小贡献相加后，整体波动会随维度增加。若直接交给 softmax，概率容易过早变得极端，梯度也会变小。',
      '',
      '因此学习顺序是：先确认点积与方差，再观察 softmax 饱和，最后回到完整公式。',
    ].join('\n'),
    learnerAssumptions: [{
      concept: '矩阵乘法',
      state: 'pending_ai_inference' as const,
      action: 'diagnose' as const,
      provenance: 'AI 根据当前节点标题推测，尚未获得用户确认',
    }],
    teachingSequence: [
      {
        title: '先建立数值尺度直觉',
        purpose: '避免一开始被完整公式和符号压住。',
        dossierItemIds: ['dot-product-variance', 'softmax-saturation'],
      },
      {
        title: '回到缩放点积公式',
        purpose: '把前面的数值机制重新连接到目标概念。',
        dossierItemIds: ['scaled-dot-product'],
      },
    ],
    diagnosticQuestions: ['如果向量维度翻倍，你预期未缩放点积的典型波动怎样变化？'],
    styleDecision: '先用一句人话给全景，再从数值直觉过渡到公式。',
    outsideKnowledgeUsed: false,
  };
}

function graphCompilationFixture(
  dossier: KnowledgeDossier,
  teachingPlan: TeachingPlan,
): GraphCompilation {
  return {
    version: 1,
    dossierFingerprint: fingerprintDeepBuildArtifact('kd1', dossier),
    teachingPlanFingerprint: fingerprintDeepBuildArtifact('tp1', teachingPlan),
    learningExpansion: {
      version: 1,
      answerMarkdown: teachingPlan.adaptedAnswerMarkdown,
      keyPoints: [
        {
          title: '点积方差',
          importance: 9,
          importanceReason: '这是理解缩放因子的直接数值基础。',
        },
        {
          title: 'softmax 饱和',
          importance: 8,
          importanceReason: '它解释不缩放为什么会影响训练。',
        },
      ],
      patch: {
        version: 1,
        summary: '先理解数值尺度，再理解 softmax 饱和。',
        nodes: [
          {
            clientId: 'dot-product-variance',
            title: '点积方差',
            subtitle: '维度与数值波动',
            importance: 9,
            status: 'learning',
            document: { title: '点积方差', body: '# 点积方差\n\n多个分量乘积相加后，方差会随维度增长。' },
          },
          {
            clientId: 'softmax-saturation',
            title: 'softmax 饱和',
            subtitle: '概率为何过早极端',
            importance: 8,
            status: 'learning',
            document: { title: 'softmax 饱和', body: '# softmax 饱和\n\n过大的分数会让概率接近 0 或 1。' },
          },
        ],
        edges: [
          {
            clientId: 'edge-variance',
            sourceRef: 'selection',
            targetRef: 'dot-product-variance',
            relation: 'prerequisite',
            importance: 9,
            document: { title: '前置关系', body: '先理解点积尺度，才能理解为什么需要缩放。' },
          },
          {
            clientId: 'edge-softmax',
            sourceRef: 'dot-product-variance',
            targetRef: 'softmax-saturation',
            relation: 'support',
            importance: 8,
            document: { title: '机制关系', body: '数值尺度变大后，softmax 更容易进入饱和区。' },
          },
        ],
      },
    },
    coverage: [
      {
        dossierItemId: 'scaled-dot-product',
        disposition: 'answer_only',
        nodeTitle: null,
        reason: '当前目标本身已经在个性化回答中解释，不重复创建同名节点。',
      },
      {
        dossierItemId: 'dot-product-variance',
        disposition: 'node',
        nodeTitle: '点积方差',
        reason: '它是需要单独学习和验证的直接前置。',
      },
      {
        dossierItemId: 'softmax-saturation',
        disposition: 'node',
        nodeTitle: 'softmax 饱和',
        reason: '它解释缩放的训练意义，适合继续追问。',
      },
    ],
  };
}
