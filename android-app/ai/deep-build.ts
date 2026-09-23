import { validateLearningExpansion, type LearningExpansion } from '@/ai/graph-patch';

export const DEEP_BUILD_VERSION = 1 as const;
export const KNOWLEDGE_DOSSIER_VERSION = 1 as const;
export const TEACHING_PLAN_VERSION = 1 as const;
export const GRAPH_COMPILATION_VERSION = 1 as const;

export type ExpansionTrigger = 'new_project' | 'node_question';
export type ExpansionQualityChoice = 'auto' | 'quick' | 'deep';
export type ExpansionQualityPath = Exclude<ExpansionQualityChoice, 'auto'>;
export type DeepBuildSourceBoundary = 'learning_open' | 'source_bounded';
export type DeepBuildStage = 'knowledge_dossier' | 'teaching_plan' | 'graph_compilation';
export type DeepBuildStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown_charge';
export type DeepBuildRunStatus = 'ready' | 'running' | 'failed' | 'unknown_charge' | 'succeeded';

export type KnowledgeDossierItemRole =
  | 'concept'
  | 'prerequisite'
  | 'misconception'
  | 'example'
  | 'uncertainty';

export type KnowledgeDossierItem = {
  id: string;
  role: KnowledgeDossierItemRole;
  title: string;
  body: string;
  sourceRefs: string[];
};

export type KnowledgeDossier = {
  version: typeof KNOWLEDGE_DOSSIER_VERSION;
  sourceBoundary: DeepBuildSourceBoundary;
  goal: string;
  canonicalAnswerMarkdown: string;
  items: KnowledgeDossierItem[];
  completenessNotes: string;
};

export type LearnerKnowledgeState =
  | 'self_reported_known'
  | 'learner_verified'
  | 'pending_ai_inference'
  | 'unknown';

export type LearnerInstructionAction = 'assume' | 'diagnose' | 'teach';

export type LearnerAssumption = {
  concept: string;
  state: LearnerKnowledgeState;
  action: LearnerInstructionAction;
  provenance: string;
};

export type TeachingPlan = {
  version: typeof TEACHING_PLAN_VERSION;
  dossierFingerprint: string;
  adaptedAnswerMarkdown: string;
  learnerAssumptions: LearnerAssumption[];
  teachingSequence: Array<{
    title: string;
    purpose: string;
    dossierItemIds: string[];
  }>;
  diagnosticQuestions: string[];
  styleDecision: string;
  outsideKnowledgeUsed: boolean;
};

export type GraphCoverageDisposition = 'node' | 'answer_only' | 'deferred';

export type GraphCompilation = {
  version: typeof GRAPH_COMPILATION_VERSION;
  dossierFingerprint: string;
  teachingPlanFingerprint: string;
  learningExpansion: LearningExpansion;
  coverage: Array<{
    dossierItemId: string;
    disposition: GraphCoverageDisposition;
    nodeTitle: string | null;
    reason: string;
  }>;
};

export type DeepBuildStageState = {
  stage: DeepBuildStage;
  status: DeepBuildStageStatus;
  requestId: string | null;
  artifactFingerprint: string | null;
  errorCode: string | null;
  updatedAt: string;
};

export type DeepBuildRun = {
  version: typeof DEEP_BUILD_VERSION;
  runId: string;
  contextFingerprint: string;
  sourceBoundary: DeepBuildSourceBoundary;
  status: DeepBuildRunStatus;
  stages: Record<DeepBuildStage, DeepBuildStageState>;
};

const STAGE_ORDER: DeepBuildStage[] = [
  'knowledge_dossier',
  'teaching_plan',
  'graph_compilation',
];

const identifierPattern = /^[a-z][a-z0-9-]{0,63}$/u;

export class DeepBuildValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`DeepBuild 结果无效：${issues.join('；')}`);
    this.name = 'DeepBuildValidationError';
  }
}

export function selectExpansionQualityPath(
  trigger: ExpansionTrigger,
  choice: ExpansionQualityChoice = 'auto',
): ExpansionQualityPath {
  if (choice !== 'auto') return choice;
  return trigger === 'new_project' ? 'deep' : 'quick';
}

export function validateKnowledgeDossier(input: unknown): KnowledgeDossier {
  const issues: string[] = [];
  if (!isRecord(input)) throw new DeepBuildValidationError(['知识底稿必须是对象']);
  if (input.version !== KNOWLEDGE_DOSSIER_VERSION) issues.push('知识底稿 version 必须为 1');
  const sourceBoundary = readEnum(
    input.sourceBoundary,
    ['learning_open', 'source_bounded'] as const,
    'sourceBoundary',
    issues,
  );
  const goal = readString(input.goal, 'goal', 1, 240, issues);
  const canonicalAnswerMarkdown = readString(
    input.canonicalAnswerMarkdown,
    'canonicalAnswerMarkdown',
    200,
    60_000,
    issues,
  );
  const completenessNotes = readString(input.completenessNotes, 'completenessNotes', 12, 2_000, issues);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!Array.isArray(input.items)) issues.push('items 必须是数组');
  if (rawItems.length < 1 || rawItems.length > 80) issues.push('items 数量必须在 1-80 之间');
  const ids = new Set<string>();
  const items = rawItems.map((value, index) => {
    const path = `items[${index}]`;
    if (!isRecord(value)) {
      issues.push(`${path} 必须是对象`);
      return emptyDossierItem();
    }
    const id = readString(value.id, `${path}.id`, 1, 64, issues);
    if (!identifierPattern.test(id)) issues.push(`${path}.id 格式非法`);
    if (ids.has(id)) issues.push(`${path}.id 重复：${id}`);
    ids.add(id);
    const role = readEnum(
      value.role,
      ['concept', 'prerequisite', 'misconception', 'example', 'uncertainty'] as const,
      `${path}.role`,
      issues,
    );
    const sourceRefs = readStringArray(value.sourceRefs, `${path}.sourceRefs`, 0, 16, issues);
    if (sourceBoundary === 'source_bounded' && role !== 'uncertainty' && sourceRefs.length === 0) {
      issues.push(`${path} 在来源限定模式下必须保留 sourceRefs`);
    }
    return {
      id,
      role,
      title: readString(value.title, `${path}.title`, 1, 160, issues),
      body: readString(value.body, `${path}.body`, 12, 8_000, issues),
      sourceRefs,
    };
  });
  if (!items.some((item) => item.role === 'concept')) issues.push('知识底稿至少需要一个 concept');
  if (issues.length > 0) throw new DeepBuildValidationError(issues);
  return {
    version: KNOWLEDGE_DOSSIER_VERSION,
    sourceBoundary,
    goal,
    canonicalAnswerMarkdown,
    items,
    completenessNotes,
  };
}

export function validateTeachingPlan(
  input: unknown,
  dossier: KnowledgeDossier,
): TeachingPlan {
  const issues: string[] = [];
  if (!isRecord(input)) throw new DeepBuildValidationError(['教学方案必须是对象']);
  if (input.version !== TEACHING_PLAN_VERSION) issues.push('教学方案 version 必须为 1');
  const dossierFingerprint = readString(input.dossierFingerprint, 'dossierFingerprint', 8, 80, issues);
  const expectedDossierFingerprint = fingerprintDeepBuildArtifact('kd1', dossier);
  if (dossierFingerprint !== expectedDossierFingerprint) issues.push('教学方案引用的知识底稿指纹不一致');
  const adaptedAnswerMarkdown = readString(
    input.adaptedAnswerMarkdown,
    'adaptedAnswerMarkdown',
    120,
    60_000,
    issues,
  );
  const learnerAssumptions = parseLearnerAssumptions(input.learnerAssumptions, issues);
  const teachingSequence = parseTeachingSequence(input.teachingSequence, dossier, issues);
  const diagnosticQuestions = readStringArray(input.diagnosticQuestions, 'diagnosticQuestions', 0, 12, issues);
  const styleDecision = readString(input.styleDecision, 'styleDecision', 8, 1_000, issues);
  const outsideKnowledgeUsed = typeof input.outsideKnowledgeUsed === 'boolean'
    ? input.outsideKnowledgeUsed
    : false;
  if (typeof input.outsideKnowledgeUsed !== 'boolean') issues.push('outsideKnowledgeUsed 必须是布尔值');
  if (dossier.sourceBoundary === 'source_bounded' && outsideKnowledgeUsed) {
    issues.push('来源限定模式不能引入外部知识');
  }
  if (issues.length > 0) throw new DeepBuildValidationError(issues);
  return {
    version: TEACHING_PLAN_VERSION,
    dossierFingerprint,
    adaptedAnswerMarkdown,
    learnerAssumptions,
    teachingSequence,
    diagnosticQuestions,
    styleDecision,
    outsideKnowledgeUsed,
  };
}

export function validateGraphCompilation(
  input: unknown,
  dossier: KnowledgeDossier,
  teachingPlan: TeachingPlan,
): GraphCompilation {
  const issues: string[] = [];
  if (!isRecord(input)) throw new DeepBuildValidationError(['图谱编译结果必须是对象']);
  if (input.version !== GRAPH_COMPILATION_VERSION) issues.push('图谱编译 version 必须为 1');
  const dossierFingerprint = readString(input.dossierFingerprint, 'dossierFingerprint', 8, 80, issues);
  const teachingPlanFingerprint = readString(
    input.teachingPlanFingerprint,
    'teachingPlanFingerprint',
    8,
    80,
    issues,
  );
  if (dossierFingerprint !== fingerprintDeepBuildArtifact('kd1', dossier)) {
    issues.push('图谱编译引用的知识底稿指纹不一致');
  }
  if (teachingPlanFingerprint !== fingerprintDeepBuildArtifact('tp1', teachingPlan)) {
    issues.push('图谱编译引用的教学方案指纹不一致');
  }
  let learningExpansion: LearningExpansion;
  try {
    learningExpansion = validateLearningExpansion(input.learningExpansion);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'learningExpansion 无效');
    learningExpansion = emptyLearningExpansion();
  }
  if (learningExpansion.answerMarkdown !== teachingPlan.adaptedAnswerMarkdown) {
    issues.push('第三阶段不能改写第二阶段已经确认的个性化回答');
  }
  const coverage = parseCoverage(input.coverage, dossier, learningExpansion, issues);
  if (issues.length > 0) throw new DeepBuildValidationError(issues);
  return {
    version: GRAPH_COMPILATION_VERSION,
    dossierFingerprint,
    teachingPlanFingerprint,
    learningExpansion,
    coverage,
  };
}

export function createDeepBuildRun(input: {
  runId: string;
  contextFingerprint: string;
  sourceBoundary: DeepBuildSourceBoundary;
  now: string;
}): DeepBuildRun {
  if (!input.runId.trim() || !input.contextFingerprint.trim() || !input.now.trim()) {
    throw new Error('DeepBuild 运行标识、上下文指纹和时间不能为空');
  }
  const stage = (value: DeepBuildStage): DeepBuildStageState => ({
    stage: value,
    status: 'pending',
    requestId: null,
    artifactFingerprint: null,
    errorCode: null,
    updatedAt: input.now,
  });
  return {
    version: DEEP_BUILD_VERSION,
    runId: input.runId,
    contextFingerprint: input.contextFingerprint,
    sourceBoundary: input.sourceBoundary,
    status: 'ready',
    stages: {
      knowledge_dossier: stage('knowledge_dossier'),
      teaching_plan: stage('teaching_plan'),
      graph_compilation: stage('graph_compilation'),
    },
  };
}

export function getNextDeepBuildStage(run: DeepBuildRun): DeepBuildStage | null {
  for (const stage of STAGE_ORDER) {
    const state = run.stages[stage];
    if (state.status === 'succeeded') continue;
    if (state.status === 'pending' || state.status === 'failed') return stage;
    return null;
  }
  return null;
}

export function startDeepBuildStage(
  run: DeepBuildRun,
  stage: DeepBuildStage,
  requestId: string,
  now: string,
  options: { manualRetry?: boolean } = {},
): DeepBuildRun {
  const expected = getNextDeepBuildStage(run);
  if (expected !== stage) throw new Error(`DeepBuild 当前不能启动 ${stage}`);
  const current = run.stages[stage];
  if (current.status === 'failed' && !options.manualRetry) {
    throw new Error('失败阶段只能由用户明确重试');
  }
  if (current.status === 'unknown_charge') {
    throw new Error('费用状态不明的阶段不能重试');
  }
  return updateStage(run, stage, {
    status: 'running',
    requestId: requireText(requestId, 'requestId'),
    artifactFingerprint: null,
    errorCode: null,
    updatedAt: requireText(now, 'now'),
  }, 'running');
}

export function completeDeepBuildStage(
  run: DeepBuildRun,
  stage: DeepBuildStage,
  artifactFingerprint: string,
  now: string,
): DeepBuildRun {
  if (run.stages[stage].status !== 'running') throw new Error(`${stage} 尚未处于运行状态`);
  const next = updateStage(run, stage, {
    status: 'succeeded',
    artifactFingerprint: requireText(artifactFingerprint, 'artifactFingerprint'),
    errorCode: null,
    updatedAt: requireText(now, 'now'),
  }, stage === 'graph_compilation' ? 'succeeded' : 'ready');
  return next;
}

export function failDeepBuildStage(
  run: DeepBuildRun,
  stage: DeepBuildStage,
  failure: { code: string; chargeState: 'known' | 'unknown'; now: string },
): DeepBuildRun {
  if (run.stages[stage].status !== 'running') throw new Error(`${stage} 尚未处于运行状态`);
  const unknown = failure.chargeState === 'unknown';
  return updateStage(run, stage, {
    status: unknown ? 'unknown_charge' : 'failed',
    artifactFingerprint: null,
    errorCode: requireText(failure.code, 'failure.code'),
    updatedAt: requireText(failure.now, 'failure.now'),
  }, unknown ? 'unknown_charge' : 'failed');
}

export function fingerprintDeepBuildArtifact(prefix: 'kd1' | 'tp1' | 'gc1', value: unknown) {
  const text = stableStringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${prefix}-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function parseLearnerAssumptions(input: unknown, issues: string[]): LearnerAssumption[] {
  const raw = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) issues.push('learnerAssumptions 必须是数组');
  if (raw.length > 40) issues.push('learnerAssumptions 不能超过 40 项');
  return raw.map((value, index) => {
    const path = `learnerAssumptions[${index}]`;
    if (!isRecord(value)) {
      issues.push(`${path} 必须是对象`);
      return { concept: '', state: 'unknown', action: 'teach', provenance: '' };
    }
    const state = readEnum(
      value.state,
      ['self_reported_known', 'learner_verified', 'pending_ai_inference', 'unknown'] as const,
      `${path}.state`,
      issues,
    );
    const action = readEnum(value.action, ['assume', 'diagnose', 'teach'] as const, `${path}.action`, issues);
    if (action === 'assume' && state !== 'self_reported_known' && state !== 'learner_verified') {
      issues.push(`${path} 只有用户明确或学习者验证的知识才能直接 assume`);
    }
    if (state === 'pending_ai_inference' && action !== 'diagnose') {
      issues.push(`${path} AI 推测必须先 diagnose，不能直接视为已知或未知`);
    }
    return {
      concept: readString(value.concept, `${path}.concept`, 1, 160, issues),
      state,
      action,
      provenance: readString(value.provenance, `${path}.provenance`, 2, 300, issues),
    };
  });
}

function parseTeachingSequence(input: unknown, dossier: KnowledgeDossier, issues: string[]) {
  const raw = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) issues.push('teachingSequence 必须是数组');
  if (raw.length < 1 || raw.length > 30) issues.push('teachingSequence 数量必须在 1-30 之间');
  const itemIds = new Set(dossier.items.map((item) => item.id));
  return raw.map((value, index) => {
    const path = `teachingSequence[${index}]`;
    if (!isRecord(value)) {
      issues.push(`${path} 必须是对象`);
      return { title: '', purpose: '', dossierItemIds: [] };
    }
    const dossierItemIds = readStringArray(value.dossierItemIds, `${path}.dossierItemIds`, 1, 40, issues);
    dossierItemIds.forEach((id) => {
      if (!itemIds.has(id)) issues.push(`${path} 引用了未知知识底稿条目：${id}`);
    });
    return {
      title: readString(value.title, `${path}.title`, 1, 160, issues),
      purpose: readString(value.purpose, `${path}.purpose`, 8, 1_000, issues),
      dossierItemIds,
    };
  });
}

function parseCoverage(
  input: unknown,
  dossier: KnowledgeDossier,
  expansion: LearningExpansion,
  issues: string[],
): GraphCompilation['coverage'] {
  const raw = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) issues.push('coverage 必须是数组');
  const dossierIds = new Set(dossier.items.map((item) => item.id));
  const nodeTitles = new Set(expansion.patch.nodes.map((node) => node.title));
  const covered = new Set<string>();
  const coverage = raw.map((value, index) => {
    const path = `coverage[${index}]`;
    if (!isRecord(value)) {
      issues.push(`${path} 必须是对象`);
      return {
        dossierItemId: '',
        disposition: 'deferred' as const,
        nodeTitle: null,
        reason: '',
      };
    }
    const dossierItemId = readString(value.dossierItemId, `${path}.dossierItemId`, 1, 64, issues);
    if (!dossierIds.has(dossierItemId)) issues.push(`${path} 引用了未知知识底稿条目：${dossierItemId}`);
    if (covered.has(dossierItemId)) issues.push(`${path} 重复覆盖：${dossierItemId}`);
    covered.add(dossierItemId);
    const disposition = readEnum(
      value.disposition,
      ['node', 'answer_only', 'deferred'] as const,
      `${path}.disposition`,
      issues,
    );
    const nodeTitle = value.nodeTitle === null
      ? null
      : readString(value.nodeTitle, `${path}.nodeTitle`, 1, 160, issues);
    if (disposition === 'node' && (!nodeTitle || !nodeTitles.has(nodeTitle))) {
      issues.push(`${path} 的 nodeTitle 必须指向本次实际生成的节点`);
    }
    if (disposition !== 'node' && nodeTitle !== null) {
      issues.push(`${path} 只有 node 处置可以填写 nodeTitle`);
    }
    return {
      dossierItemId,
      disposition,
      nodeTitle,
      reason: readString(value.reason, `${path}.reason`, 8, 500, issues),
    };
  });
  dossier.items.forEach((item) => {
    if (!covered.has(item.id)) issues.push(`知识底稿条目没有覆盖决策：${item.id}`);
  });
  return coverage;
}

function updateStage(
  run: DeepBuildRun,
  stage: DeepBuildStage,
  patch: Partial<DeepBuildStageState>,
  status: DeepBuildRunStatus,
): DeepBuildRun {
  return {
    ...run,
    status,
    stages: {
      ...run.stages,
      [stage]: { ...run.stages[stage], ...patch },
    },
  };
}

function readString(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: string[],
) {
  if (typeof value !== 'string') {
    issues.push(`${path} 必须是字符串`);
    return '';
  }
  const clean = value.trim();
  if (clean.length < min || clean.length > max) issues.push(`${path} 长度必须在 ${min}-${max} 之间`);
  return clean;
}

function readStringArray(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: string[],
) {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`);
    return [];
  }
  if (value.length < min || value.length > max) issues.push(`${path} 数量必须在 ${min}-${max} 之间`);
  return value.map((item, index) => readString(item, `${path}[${index}]`, 1, 500, issues));
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  issues: string[],
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(`${path} 非法`);
    return allowed[0];
  }
  return value as T[number];
}

function requireText(value: string, label: string) {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} 不能为空`);
  return clean;
}

function emptyDossierItem(): KnowledgeDossierItem {
  return { id: '', role: 'concept', title: '', body: '', sourceRefs: [] };
}

function emptyLearningExpansion(): LearningExpansion {
  return {
    version: 1,
    answerMarkdown: '',
    keyPoints: [],
    patch: { version: 1, summary: '', nodes: [], edges: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
