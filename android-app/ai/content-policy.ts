import type {
  DetailLevel,
  ExplanationStyle,
  ProjectContentPolicy,
  ProjectMode,
  RelationType,
} from '@/types/domain';

export const CONTENT_POLICY_VERSION = 'content-policy-v1';

export const PROJECT_MODE_LABELS: Record<ProjectMode, string> = {
  learning: '学习模式',
  summary: '总结模式',
};

export const EXPLANATION_STYLE_LABELS: Record<ExplanationStyle, string> = {
  legacy: '标准表达',
  plain_language: '说人话',
};

export const DETAIL_LEVEL_LABELS: Record<DetailLevel, string> = {
  one_sentence: '一句话',
  concise: '简短',
  detailed: '详细',
  deep: '深入',
};

const DETAIL_INSTRUCTIONS: Record<DetailLevel, string> = {
  one_sentence: '正文尽量控制在 100 个中文字符以内，只保留结论、关键理由和一个必要例子。',
  concise: '正文以 300 至 600 个中文字符为宜，讲清主线，不铺陈次要分支。',
  detailed: '正文以 800 至 1600 个中文字符为宜，包含直觉、机制、例子和容易混淆之处。',
  deep: '正文可以超过 1800 个中文字符，系统展开推导、边界、反例、应用与前后知识联系。',
};

export function createProjectContentPolicy(
  input: Partial<ProjectContentPolicy> = {},
): ProjectContentPolicy {
  const mode = input.mode ?? 'learning';
  return {
    version: 1,
    mode,
    explanationStyle: input.explanationStyle ?? 'plain_language',
    detailLevel: input.detailLevel ?? 'detailed',
    allowOutsideKnowledge: input.allowOutsideKnowledge ?? mode === 'learning',
  };
}

export function buildContentPolicyInstruction(policy: ProjectContentPolicy) {
  const modeInstruction = policy.mode === 'summary'
    ? [
        '任务模式是“总结”：忠实重组用户提供的资料，不把外部常识伪装成资料原文。',
        '图谱表达原文的主题、分论点、证据、例子和结论；层级关系优先使用 contains。',
        policy.allowOutsideKnowledge
          ? '确需补充资料外知识时，必须明确标记为“补充背景”。'
          : '除非用户明确追问，否则不要引入资料之外的新事实；资料没有回答的问题要直说“资料中没有”，不要猜。',
      ].join('')
    : [
        '任务模式是“学习”：从目标知识反向寻找真正必要的前置、直觉、方法和验证点。',
        '不要机械罗列目录；每个新节点都应回答“为什么学它、学到什么程度才够用”。',
        '事实或推导拿不准时明确标注不确定，不把流畅表达当成事实核验。',
      ].join('');
  const styleInstruction = policy.explanationStyle === 'plain_language'
    ? [
        '使用“说人话”风格：先给直觉和全局图景，再解释术语；短句优先。',
        '术语第一次出现时用日常语言解释，避免用更多陌生概念解释一个陌生概念。',
        '深入浅出不等于回避严谨：重要条件、例外和因果关系仍要说清。',
      ].join('')
    : '使用准确、克制的标准教学表达，避免空泛套话和不必要的 AI 腔。';

  return [
    `内容策略版本：${CONTENT_POLICY_VERSION}`,
    modeInstruction,
    styleInstruction,
    DETAIL_INSTRUCTIONS[policy.detailLevel],
    'Markdown 必须可直接渲染：标题层级连续，列表不要假嵌套；行内公式只用 $...$，独立公式只用 $$...$$，不要混用 \\(...\\) 或 \\[...\\]。',
    '先写让人能直接阅读的完整回答，再提炼图谱节点；图谱是回答的导航，不是回答的替代品。',
  ].join('\n');
}

export function resolveContentContract(policy: ProjectContentPolicy) {
  const allowedRelations: RelationType[] = policy.mode === 'summary'
    ? ['contains', 'evidence', 'support', 'analogy', 'counterexample']
    : ['prerequisite', 'evidence', 'analogy', 'support', 'counterexample'];
  return {
    version: CONTENT_POLICY_VERSION,
    policy,
    instruction: buildContentPolicyInstruction(policy),
    allowedRelations,
    sourceBoundary: policy.mode === 'summary' && !policy.allowOutsideKnowledge
      ? 'source_bounded' as const
      : 'learning_open' as const,
    markdownMath: {
      inlineDelimiter: '$' as const,
      displayDelimiter: '$$' as const,
      legacyDelimitersAcceptedByRenderer: true,
    },
    fingerprint: contentPolicyFingerprint(policy),
  };
}

export function contentPolicyFingerprint(policy: ProjectContentPolicy) {
  return [
    CONTENT_POLICY_VERSION,
    policy.mode,
    policy.explanationStyle,
    policy.detailLevel,
    policy.allowOutsideKnowledge ? 'outside:on' : 'outside:off',
  ].join('|');
}
