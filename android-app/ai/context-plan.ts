import type { ModelLearningContext } from '@/ai/model-learning-context';

export const CONTEXT_PLAN_VERSION = 1 as const;

export type ContextQuestionShape =
  | 'definition'
  | 'reason_or_formula'
  | 'prerequisite'
  | 'comparison'
  | 'source_summary';

export type ContextEvidenceKind =
  | 'mapPurpose'
  | 'goal'
  | 'source'
  | 'focus'
  | 'path'
  | 'connection'
  | 'conversation'
  | 'soul'
  | 'favorite';

export type FutureContextEvidence = {
  id: string;
  kind: 'soul' | 'favorite';
  category: 'preference' | 'known' | 'pending' | 'favorite';
  title: string;
  text: string;
  provenance: string;
  scopeType: 'global' | 'topic' | 'project';
  scopeId: string;
  scopeLabel: string;
  searchBoost?: number;
};

export type ResolvedContextEvidence = FutureContextEvidence & {
  truncated: boolean;
  reasons: string[];
};

export type ContextBudget = {
  contextWindowTokens: number;
  reservedSystemTokens: number;
  reservedOutputTokens: number;
  safetyTokens: number;
};

export type ContextPlanItem = {
  id: string;
  kind: ContextEvidenceKind;
  title: string;
  provenance: string;
  estimatedTokens: number;
  score: number;
  required: boolean;
  truncated: boolean;
  reasons: string[];
};

export type ContextPlan = {
  version: typeof CONTEXT_PLAN_VERSION;
  questionShape: ContextQuestionShape;
  budget: ContextBudget & {
    evidenceBudgetTokens: number;
    selectedEstimatedTokens: number;
  };
  selected: ContextPlanItem[];
  omitted: Array<ContextPlanItem & { omissionReason: string }>;
  activeScopes: Array<{
    scopeType: 'global' | 'topic' | 'project';
    scopeId: string;
    label: string;
  }>;
  resolvedEvidence: ResolvedContextEvidence[];
  modelContext: ModelLearningContext;
  fingerprint: string;
};

type Candidate = ContextPlanItem & {
  text: string;
  index: number | null;
  futureEvidence: FutureContextEvidence | null;
};

const DEFAULT_BUDGET: ContextBudget = {
  contextWindowTokens: 32_000,
  reservedSystemTokens: 3_200,
  reservedOutputTokens: 4_800,
  safetyTokens: 2_000,
};

const FOLLOW_UP_PATTERN = /(?:刚才|上面|前面|继续|这个|这里|它|为什么会这样|再解释)/u;
const SOURCE_BOUND_PATTERN = /(?:只|仅).{0,8}(?:根据|基于|使用).{0,8}(?:原文|资料|文档|输入)|不要.{0,8}(?:外部|补充).{0,8}(?:知识|资料)/u;

export function classifyContextQuestion(question: string): ContextQuestionShape {
  if (SOURCE_BOUND_PATTERN.test(question) || /(?:总结|概括|归纳|提炼).{0,12}(?:原文|资料|文档|这段|输入)/u.test(question)) {
    return 'source_summary';
  }
  if (/(?:比较|对比|区别|异同|联系|共同点|不同点|有何不同)/u.test(question)) return 'comparison';
  if (/(?:前置|基础|先学|需要先|知识缺口|还缺什么|哪里没懂|学习顺序)/u.test(question)) return 'prerequisite';
  if (/(?:为什么|原理|机制|推导|公式|证明|怎么得到|为何)/u.test(question)) return 'reason_or_formula';
  return 'definition';
}

export function createContextPlan(
  source: ModelLearningContext,
  options: {
    budget?: Partial<ContextBudget>;
    futureEvidence?: FutureContextEvidence[];
    activeScopes?: ContextPlan['activeScopes'];
  } = {},
): ContextPlan {
  const questionShape = source.contentPolicy.value.mode === 'summary'
    ? 'source_summary'
    : classifyContextQuestion(source.currentQuestion.text);
  const budget = normalizeBudget(options.budget);
  const evidenceBudgetTokens = Math.max(
    256,
    budget.contextWindowTokens - budget.reservedSystemTokens - budget.reservedOutputTokens - budget.safetyTokens,
  );
  const candidates = buildCandidates(source, questionShape, options.futureEvidence ?? []);
  const required = candidates.filter((item) => item.required);
  const optional = candidates
    .filter((item) => !item.required)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selected: Candidate[] = [];
  const omitted: Array<Candidate & { omissionReason: string }> = [];
  let remaining = evidenceBudgetTokens;

  for (const candidate of [...required, ...optional]) {
    if (!candidate.required && candidate.score < 30) {
      omitted.push({ ...candidate, omissionReason: '与本次问题无直接关系' });
      continue;
    }
    if (candidate.estimatedTokens <= remaining) {
      selected.push(candidate);
      remaining -= candidate.estimatedTokens;
      continue;
    }
    if (candidate.required && remaining >= 64) {
      const fitted = fitCandidate(candidate, remaining);
      selected.push(fitted);
      remaining -= fitted.estimatedTokens;
      continue;
    }
    omitted.push({
      ...candidate,
      omissionReason: candidate.score <= 0 ? '与本次问题无直接关系' : '超出本次上下文预算',
    });
  }

  const selectedIds = new Set(selected.map((item) => item.id));
  const selectedById = new Map(selected.map((item) => [item.id, item]));
  const modelContext = projectModelContext(source, selectedIds, selectedById, questionShape === 'source_summary');
  const resolvedEvidence = selected.flatMap((candidate): ResolvedContextEvidence[] => {
    if (!candidate.futureEvidence) return [];
    return [{
      ...candidate.futureEvidence,
      text: candidate.text,
      truncated: candidate.truncated,
      reasons: candidate.reasons,
    }];
  });
  const publicSelected = selected.map(stripCandidateText);
  const publicOmitted = omitted.map(({
    text: _text,
    index: _index,
    futureEvidence: _futureEvidence,
    ...item
  }) => item);
  const selectedEstimatedTokens = publicSelected.reduce((total, item) => total + item.estimatedTokens, 0);
  const fingerprint = stableFingerprint({
    version: CONTEXT_PLAN_VERSION,
    questionShape,
    selected: publicSelected.map((item) => ({ id: item.id, truncated: item.truncated })),
    activeScopes: options.activeScopes ?? [],
    resolvedEvidence,
    modelContext,
  });

  return {
    version: CONTEXT_PLAN_VERSION,
    questionShape,
    budget: { ...budget, evidenceBudgetTokens, selectedEstimatedTokens },
    selected: publicSelected,
    omitted: publicOmitted,
    activeScopes: options.activeScopes ?? [],
    resolvedEvidence,
    modelContext,
    fingerprint,
  };
}

function buildCandidates(
  source: ModelLearningContext,
  shape: ContextQuestionShape,
  futureEvidence: FutureContextEvidence[],
): Candidate[] {
  const question = source.currentQuestion.text;
  const sourceBound = shape === 'source_summary';
  const candidates: Candidate[] = [
    candidate('map-purpose', 'mapPurpose', '图谱用途', '应用固定说明', source.mapPurpose, 100, true, ['说明任务与图谱语义']),
    candidate('goal', 'goal', '最初目标或问题', '项目标题', source.originalGoalOrQuestion, 96, true, ['定位整张图的学习目标']),
    candidate(
      'focus',
      'focus',
      `当前关注：${source.currentFocus.title}`,
      source.currentFocus.note ? `当前节点笔记 · ${source.currentFocus.note.kind}` : '当前节点',
      JSON.stringify(source.currentFocus),
      100,
      true,
      ['本轮问题依附于当前节点'],
    ),
  ];

  if (source.sourceOrPriorUnderstanding) {
    const relevance = relevanceScore(question, source.sourceOrPriorUnderstanding.text);
    const selectedScore = sourceBound ? 100 : shape === 'reason_or_formula' ? 36 + relevance : 18 + relevance;
    candidates.push(candidate(
      'source',
      'source',
      '补充资料或已有理解',
      '项目原始资料',
      source.sourceOrPriorUnderstanding.text,
      selectedScore,
      sourceBound,
      sourceBound ? ['问题明确要求以原始资料为边界'] : ['原始资料与问题的词面相关度'],
    ));
  }

  source.pathFromGoal.forEach((item, index) => {
    const relevance = relevanceScore(question, item.title);
    const score = shape === 'prerequisite'
      ? 62 + Math.min(18, index * 3)
      : shape === 'comparison'
        ? 28 + relevance
        : 0;
    candidates.push(candidate(
      `path:${index}`,
      'path',
      item.title,
      '从目标到当前节点的路径',
      JSON.stringify(item),
      sourceBound ? -50 : score,
      false,
      shape === 'prerequisite' ? ['前置诊断需要观察到达当前节点的依赖链'] : ['仅在问题命中该路径节点时使用'],
      index,
    ));
  });

  source.directConnections.forEach((item, index) => {
    const relevance = relevanceScore(question, `${item.title} ${item.relation} ${item.note?.text ?? ''}`);
    const relationBoost = shape === 'prerequisite' && item.relation === 'prerequisite' ? 48 : 0;
    const shapeBoost = shape === 'comparison' ? 42 : shape === 'reason_or_formula' ? 28 : 0;
    candidates.push(candidate(
      `connection:${index}`,
      'connection',
      item.title,
      `直接关系 · ${item.direction} · ${item.relation}${item.note ? ` · ${item.note.kind}` : ''}`,
      JSON.stringify(item),
      sourceBound ? -50 : relevance + relationBoost + shapeBoost,
      false,
      ['直接相连知识按问题形态、关系类型和文本相关度选择'],
      index,
    ));
  });

  source.recentConversation.forEach((item, index) => {
    const relevance = relevanceScore(question, `${item.question} ${item.answer}`);
    const followUpBoost = FOLLOW_UP_PATTERN.test(question) ? 38 : 0;
    candidates.push(candidate(
      `conversation:${index}`,
      'conversation',
      `最近问答 ${index + 1}`,
      '当前节点已保存回答',
      JSON.stringify(item),
      sourceBound ? -50 : relevance + followUpBoost,
      false,
      ['只在追问承接或内容相关时使用'],
      index,
    ));
  });

  futureEvidence.forEach((item, index) => {
    const relevance = relevanceScore(question, `${item.title} ${item.text}`);
    const categoryBoost = item.category === 'preference'
      ? 70
      : item.category === 'known'
        ? 24
        : item.category === 'pending'
          ? 12
          : 18;
    const required = !sourceBound && item.category === 'preference';
    candidates.push(candidate(
      `${item.kind}:${item.id}`,
      item.kind,
      item.title,
      item.provenance,
      item.text,
      sourceBound ? -100 : relevance + categoryBoost + (item.searchBoost ?? 0),
      required,
      [
        sourceBound
          ? '来源限定总结默认隔离外部记忆'
          : item.category === 'preference'
            ? '这是已启用的表达或教学偏好'
            : '按本次问题的文本、来源和用户策展信号选择',
      ],
      index,
      item,
    ));
  });

  return candidates;
}

function projectModelContext(
  source: ModelLearningContext,
  selectedIds: Set<string>,
  selectedById: Map<string, Candidate>,
  sourceBound: boolean,
): ModelLearningContext {
  const sourceCandidate = selectedById.get('source');
  const focusCandidate = selectedById.get('focus');
  return {
    ...source,
    sourceOrPriorUnderstanding: selectedIds.has('source') && source.sourceOrPriorUnderstanding
      ? {
        ...source.sourceOrPriorUnderstanding,
        text: sourceCandidate?.truncated ? extractFittedText(sourceCandidate.text) : source.sourceOrPriorUnderstanding.text,
        truncated: source.sourceOrPriorUnderstanding.truncated || Boolean(sourceCandidate?.truncated),
      }
      : null,
    currentFocus: {
      ...source.currentFocus,
      note: sourceBound && source.currentFocus.note?.kind !== 'source'
        ? null
        : source.currentFocus.note && focusCandidate?.truncated
          ? {
            ...source.currentFocus.note,
            text: extractFocusNote(focusCandidate.text, source.currentFocus.note.text),
            truncated: true,
          }
          : source.currentFocus.note,
    },
    pathFromGoal: source.pathFromGoal.filter((_item, index) => selectedIds.has(`path:${index}`)),
    directConnections: source.directConnections.filter((_item, index) => selectedIds.has(`connection:${index}`)),
    recentConversation: source.recentConversation.filter((_item, index) => selectedIds.has(`conversation:${index}`)),
  };
}

function candidate(
  id: string,
  kind: ContextEvidenceKind,
  title: string,
  provenance: string,
  text: string,
  score: number,
  required: boolean,
  reasons: string[],
  index: number | null = null,
  futureEvidence: FutureContextEvidence | null = null,
): Candidate {
  return {
    id,
    kind,
    title,
    provenance,
    text,
    estimatedTokens: estimateTokens(text),
    score,
    required,
    truncated: false,
    reasons,
    index,
    futureEvidence,
  };
}

function normalizeBudget(input: Partial<ContextBudget> | undefined): ContextBudget {
  const value = { ...DEFAULT_BUDGET, ...input };
  for (const key of Object.keys(value) as Array<keyof ContextBudget>) {
    if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error(`无效上下文预算：${key}`);
    value[key] = Math.floor(value[key]);
  }
  if (value.contextWindowTokens < 1_024) throw new Error('上下文窗口预算不能小于 1024 tokens');
  return value;
}

function estimateTokens(text: string) {
  const ascii = (text.match(/[\x00-\x7F]/gu) ?? []).length;
  const nonAscii = Math.max(0, text.length - ascii);
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

function fitCandidate(item: Candidate, remainingTokens: number): Candidate {
  const maxCharacters = Math.max(64, Math.floor(remainingTokens * 1.5));
  const text = semanticTruncate(item.text, maxCharacters);
  return {
    ...item,
    text,
    estimatedTokens: Math.min(remainingTokens, estimateTokens(text)),
    truncated: true,
    reasons: [...item.reasons, '必需内容超过预算，已按段落边界截断'],
  };
}

function semanticTruncate(text: string, maxCharacters: number) {
  if (text.length <= maxCharacters) return text;
  const paragraphs = text.split(/\n{2,}/u);
  let output = '';
  for (const paragraph of paragraphs) {
    const next = output ? `${output}\n\n${paragraph}` : paragraph;
    if (next.length > maxCharacters - 16) break;
    output = next;
  }
  if (!output) output = text.slice(0, Math.max(1, maxCharacters - 16));
  return `${output.trim()}\n\n[内容已截断]`;
}

function extractFittedText(text: string) {
  return text;
}

function extractFocusNote(fittedJson: string, fallback: string) {
  try {
    const parsed = JSON.parse(fittedJson) as { note?: { text?: unknown } };
    return typeof parsed.note?.text === 'string' ? parsed.note.text : semanticTruncate(fallback, Math.max(80, fittedJson.length));
  } catch {
    return semanticTruncate(fallback, Math.max(80, fittedJson.length));
  }
}

function relevanceScore(question: string, text: string) {
  const terms = keywordTerms(question);
  if (!terms.length) return 0;
  const normalized = text.toLocaleLowerCase();
  const matches = terms.filter((term) => normalized.includes(term)).length;
  return Math.min(72, matches * 18);
}

function keywordTerms(text: string) {
  const normalized = text.toLocaleLowerCase().replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’]/gu, ' ');
  const words = normalized.match(/[a-z0-9_+-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = new Set<string>();
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 4) {
      for (let index = 0; index <= word.length - 2; index += 1) terms.add(word.slice(index, index + 2));
    } else {
      terms.add(word);
    }
  }
  return [...terms].filter((term) => !['什么', '怎么', '这个', '一下', '可以', '需要'].includes(term));
}

function stripCandidateText({
  text: _text,
  index: _index,
  futureEvidence: _futureEvidence,
  ...item
}: Candidate): ContextPlanItem {
  return item;
}

export function createProviderContextPayload(plan: ContextPlan) {
  return {
    ...plan.modelContext,
    learnerContext: {
      activeScopes: plan.activeScopes,
      explanationPreferences: plan.resolvedEvidence
        .filter((item) => item.category === 'preference')
        .map(providerEvidence),
      confirmedKnownKnowledge: plan.resolvedEvidence
        .filter((item) => item.category === 'known')
        .map(providerEvidence),
      pendingLearnerKnowledge: plan.resolvedEvidence
        .filter((item) => item.category === 'pending')
        .map(providerEvidence),
      favoriteEvidence: plan.resolvedEvidence
        .filter((item) => item.category === 'favorite')
        .map(providerEvidence),
    },
  };
}

function providerEvidence(item: ResolvedContextEvidence) {
  return {
    id: `${item.kind}:${item.id}`,
    title: item.title,
    text: item.text,
    provenance: item.provenance,
    truncated: item.truncated,
  };
}

function stableFingerprint(value: unknown) {
  const text = stableStringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `cp1-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
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
