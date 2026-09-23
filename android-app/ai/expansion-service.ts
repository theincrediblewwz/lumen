import type { SQLiteDatabase } from 'expo-sqlite';

import {
  ByokProviderError,
  requestByokGraphPatch,
  requestByokStructuredJson,
  type ByokStructuredResult,
  type ByokUsage,
} from '@/ai/byok-client';
import { getByokCredentials } from '@/ai/byok-profile';
import { createCompatibleProviderContext } from '@/ai/compatible-chat-draft';
import { createContextPlan, type ContextPlan } from '@/ai/context-plan';
import {
  DeepBuildValidationError,
  fingerprintDeepBuildArtifact,
  validateKnowledgeDossier,
  validateTeachingPlan,
  type DeepBuildStage,
  type ExpansionQualityPath,
  type GraphCompilation,
  type KnowledgeDossier,
  type TeachingPlan,
} from '@/ai/deep-build';
import {
  buildGraphCompilationRequest,
  buildKnowledgeDossierRequest,
  buildTeachingPlanRequest,
  composeGraphCompilation,
  DEEP_BUILD_STAGE_LABELS,
  normalizeGraphStructuralDraft,
  normalizeKnowledgeDossierDraft,
  normalizeTeachingPlanDraft,
  sourceBoundaryFromPlan,
} from '@/ai/deep-build-prompts';
import { AiGatewayError, getExpansionAdapterMode, requestGraphExpansion } from '@/ai/gateway-client';
import {
  GraphPatchValidationError,
  validateLearningExpansion,
  type ExpansionContext,
} from '@/ai/graph-patch';
import { createLocalExpansion } from '@/ai/local-expansion-adapter';
import { createModelLearningContext } from '@/ai/model-learning-context';
import {
  claimDeepBuildStage,
  claimExpansionJob,
  createExpansionJob,
  findActiveExpansionJob,
  findDeepBuildResumeCandidate,
  listDeepBuildStages,
  markDeepBuildStageFailed,
  markDeepBuildStageSucceeded,
  markExpansionFailed,
  markExpansionRetry,
  prepareDeepBuildRetry,
  readExpansionContextPlan,
  readDeepBuildArtifact,
  recoverStaleExpansionJobs,
  saveExpansionContextPlan,
  type ExpansionAdapter,
} from '@/data/expansion-jobs';
import { buildExpansionContext, commitGraphPatch } from '@/data/knowledge-repository';
import { loadPersonalContextEvidence } from '@/data/personal-context';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [600, 1_500];

export type ExpansionResult = {
  adapter: ExpansionAdapter;
  qualityPath: ExpansionQualityPath;
  jobId: string;
  nodeCount: number;
  edgeCount: number;
  summary: string;
  usage: ByokUsage | null;
  actualModel: string | null;
  answerId: string;
  batchId: string;
};

export type DeepBuildProgress = {
  current: 1 | 2 | 3;
  total: 3;
  stage: DeepBuildStage;
  label: string;
};

export type ExpansionOptions = {
  qualityPath?: ExpansionQualityPath;
  onProgress?: (progress: DeepBuildProgress) => void;
};

export async function getPreferredExpansionAdapter(): Promise<ExpansionAdapter> {
  if (await getByokCredentials()) return 'byok';
  return getExpansionAdapterMode();
}

export async function expandKnowledgeNode(
  db: SQLiteDatabase,
  nodeId: string,
  prompt: string,
  options: ExpansionOptions = {},
): Promise<ExpansionResult> {
  await recoverStaleExpansionJobs(db);
  const qualityPath = options.qualityPath ?? 'quick';
  const provisionalJobId = createId('expand');
  let context = await buildExpansionContext(db, nodeId, prompt, provisionalJobId);
  let existing = await findActiveExpansionJob(db, context.project.id, context.selection.id);
  const preferredAdapter = await getPreferredExpansionAdapter();
  if (qualityPath === 'deep' && preferredAdapter !== 'byok') {
    throw new Error('深入构建第一版需要先配置个人 AI；本地演示和 Gateway 仍可使用快速生成');
  }
  if (
    existing
    && existing.status !== 'running'
    && (existing.adapter !== preferredAdapter || existing.qualityPath !== qualityPath)
  ) {
    await markExpansionFailed(
      db,
      existing.id,
      'expansion_route_changed',
      'AI 连接方式或生成方式已经改变，请按当前选择重新发送',
    );
    existing = null;
  }
  if (!existing && qualityPath === 'deep' && preferredAdapter === 'byok') {
    existing = await findDeepBuildResumeCandidate(
      db,
      context.project.id,
      context.selection.id,
      context.prompt,
    );
    if (existing) await prepareDeepBuildRetry(db, existing.id);
  }
  const adapter = existing?.adapter ?? preferredAdapter;
  const jobId = existing?.id ?? provisionalJobId;
  if (existing) {
    if (existing.status === 'running') {
      throw new Error('这个知识点的展开任务仍由另一个执行器持有租约，请稍后再试');
    }
    try {
      const savedContext = JSON.parse(existing.requestJson) as typeof context;
      if (savedContext.schemaVersion !== 2) throw new Error('旧版展开上下文不能继续使用');
      context = savedContext;
    } catch {
      await markExpansionFailed(db, jobId, 'invalid_saved_request', '已保存的展开上下文无法读取');
      throw new Error('已保存的展开上下文损坏，请重新选择知识点后再试');
    }
    if (existing.status === 'retry_wait' && existing.nextRetryAt) {
      const remaining = new Date(existing.nextRetryAt).getTime() - Date.now();
      if (remaining > 0) await wait(Math.min(remaining, 3_000));
    }
  } else {
    await createExpansionJob(db, context, adapter, qualityPath);
  }

  if (qualityPath === 'deep') {
    await claimExpansionJob(db, jobId, 12 * 60_000);
    try {
      return await executeDeepBuild(db, context, jobId, options.onProgress);
    } catch (error) {
      const stages = await listDeepBuildStages(db, jobId);
      if (!stages.some((stage) => stage.status === 'failed' || stage.status === 'unknown_charge')) {
        const failure = classifyFailure(error);
        await markExpansionFailed(db, jobId, failure.code, failure.message);
      }
      throw error;
    }
  }

  const attemptsUsed = existing?.attemptCount ?? 0;
  if (attemptsUsed >= MAX_ATTEMPTS) {
    await markExpansionFailed(db, jobId, 'attempts_exhausted', '展开任务已达到最大尝试次数');
    throw new Error('展开任务已达到最大尝试次数，请稍后重新发起');
  }
  for (let attempt = attemptsUsed + 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await claimExpansionJob(db, jobId);
    try {
      const contextPlan = adapter === 'byok'
        ? await resolveExpansionContextPlan(db, context, jobId)
        : null;
      const byokResult = adapter === 'byok'
        ? await requestByokGraphPatch(context, undefined, fetch, contextPlan ?? undefined)
        : null;
      const rawExpansion = adapter === 'gateway'
        ? await requestGraphExpansion(context)
        : byokResult?.expansion ?? createLocalExpansion(context);
      const expansion = validateLearningExpansion(rawExpansion);
      const patch = expansion.patch;
      const result = await commitGraphPatch(db, context, patch, jobId, {
        adapter,
        actualModel: byokResult?.actualModel ?? null,
        body: expansion.answerMarkdown,
      });
      return {
        adapter,
        qualityPath,
        jobId,
        ...result,
        summary: patch.summary,
        usage: byokResult?.usage ?? null,
        actualModel: byokResult?.actualModel ?? null,
      };
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.retryable && attempt < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
        await markExpansionRetry(db, jobId, failure.code, failure.message, delay);
        await wait(delay);
        continue;
      }
      await markExpansionFailed(db, jobId, failure.code, failure.message);
      throw error;
    }
  }
  throw new Error('展开任务未完成');
}

async function executeDeepBuild(
  db: SQLiteDatabase,
  context: ExpansionContext,
  jobId: string,
  onProgress?: (progress: DeepBuildProgress) => void,
): Promise<ExpansionResult> {
  const contextPlan = await resolveExpansionContextPlan(db, context, jobId);
  const credentials = await getByokCredentials();
  if (!credentials) throw new ByokProviderError('尚未配置个人 AI 服务', 'byok_not_configured', false);

  let dossier: KnowledgeDossier | null = null;
  let teachingPlan: TeachingPlan | null = null;
  let graphCompilation: GraphCompilation | null = null;
  const stages = await listDeepBuildStages(db, jobId);
  if (stages.length !== 3) throw new Error('深入构建阶段记录不完整');

  for (const persisted of stages) {
    if (persisted.status === 'unknown_charge') {
      throw new Error('上次请求的费用状态不明，应用不会自动继续这个深入构建');
    }
    if (persisted.status === 'failed') {
      throw new Error('深入构建需要由用户明确继续失败阶段');
    }
    if (persisted.status === 'succeeded') {
      const artifact = readDeepBuildArtifact<unknown>(persisted);
      if (persisted.stage === 'knowledge_dossier') dossier = validateKnowledgeDossier(artifact);
      if (persisted.stage === 'teaching_plan') {
        if (!dossier) throw new Error('教学方案缺少已验证的知识底稿');
        teachingPlan = validateTeachingPlan(artifact, dossier);
      }
      if (persisted.stage === 'graph_compilation') {
        if (!dossier || !teachingPlan) throw new Error('图谱编排缺少已验证的前序产物');
        graphCompilation = composeGraphCompilationArtifact(artifact, dossier, teachingPlan);
      }
      continue;
    }

    const current = persisted.stageOrder as 1 | 2 | 3;
    onProgress?.({
      current,
      total: 3,
      stage: persisted.stage,
      label: DEEP_BUILD_STAGE_LABELS[persisted.stage],
    });
    const requestId = createId(`deep-${current}`);
    await claimDeepBuildStage(db, jobId, persisted.stage, requestId);
    let receivedResponse: ByokStructuredResult | null = null;
    try {
      if (persisted.stage === 'knowledge_dossier') {
        const response = await requestByokStructuredJson(
          buildKnowledgeDossierRequest(contextPlan),
          credentials,
        );
        receivedResponse = response;
        dossier = validateReceivedArtifact(
          () => validateKnowledgeDossier(normalizeKnowledgeDossierDraft(response.value, {
            sourceBoundary: sourceBoundaryFromPlan(contextPlan),
            goal: contextPlan.modelContext.currentQuestion.text,
          })),
          'knowledge_dossier',
        );
        await persistDeepBuildArtifact(db, jobId, persisted.stage, dossier, 'kd1', response);
      } else if (persisted.stage === 'teaching_plan') {
        if (!dossier) throw new Error('教学方案缺少知识底稿');
        const response = await requestByokStructuredJson(
          buildTeachingPlanRequest(contextPlan, dossier),
          credentials,
        );
        receivedResponse = response;
        teachingPlan = validateReceivedArtifact(
          () => validateTeachingPlan(normalizeTeachingPlanDraft(response.value, dossier!), dossier!),
          'teaching_plan',
        );
        await persistDeepBuildArtifact(db, jobId, persisted.stage, teachingPlan, 'tp1', response);
      } else {
        if (!dossier || !teachingPlan) throw new Error('图谱编排缺少前序产物');
        const response = await requestByokStructuredJson(
          buildGraphCompilationRequest(contextPlan, dossier, teachingPlan),
          credentials,
        );
        receivedResponse = response;
        graphCompilation = validateReceivedArtifact(
          () => composeGraphCompilation(
            normalizeGraphStructuralDraft(response.value, dossier!, teachingPlan!),
            dossier!,
            teachingPlan!,
          ),
          'graph_compilation',
        );
        await persistDeepBuildArtifact(db, jobId, persisted.stage, graphCompilation, 'gc1', response);
      }
    } catch (error) {
      const failure = deepBuildFailure(error);
      const providerFailure = error instanceof ByokProviderError ? error : null;
      await markDeepBuildStageFailed(db, jobId, persisted.stage, {
        ...failure,
        rejectedOutput: receivedResponse?.value ?? providerFailure?.rejectedOutput ?? undefined,
        usage: receivedResponse?.usage ?? providerFailure?.usage ?? undefined,
        actualModel: receivedResponse?.actualModel ?? providerFailure?.actualModel ?? undefined,
      });
      throw error;
    }
  }

  if (!dossier || !teachingPlan || !graphCompilation) {
    throw new Error('深入构建没有形成完整的三阶段产物');
  }
  const expansion = validateLearningExpansion(graphCompilation.learningExpansion);
  const latestStages = await listDeepBuildStages(db, jobId);
  const usage = sumStageUsage(latestStages.map((stage) => stage.usageJson));
  const actualModel = [...latestStages].reverse().find((stage) => stage.actualModel)?.actualModel ?? null;
  const result = await commitGraphPatch(db, context, expansion.patch, jobId, {
    adapter: 'byok',
    actualModel,
    body: expansion.answerMarkdown,
  });
  return {
    adapter: 'byok',
    qualityPath: 'deep',
    jobId,
    ...result,
    summary: expansion.patch.summary,
    usage,
    actualModel,
  };
}

async function resolveExpansionContextPlan(
  db: SQLiteDatabase,
  context: ExpansionContext,
  jobId: string,
): Promise<ContextPlan> {
  const persisted = await readExpansionContextPlan(db, jobId);
  if (persisted) return persisted;
  const personal = await loadPersonalContextEvidence(
    db,
    context.project.id,
    context.prompt,
  );
  const plan = createContextPlan(
    createModelLearningContext(createCompatibleProviderContext(context)),
    {
      futureEvidence: personal.evidence,
      activeScopes: personal.scopes
        .filter((scope) => scope.enabled)
        .map((scope) => ({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          label: scope.label,
        })),
    },
  );
  return saveExpansionContextPlan(db, jobId, plan);
}

async function persistDeepBuildArtifact(
  db: SQLiteDatabase,
  jobId: string,
  stage: DeepBuildStage,
  artifact: unknown,
  prefix: 'kd1' | 'tp1' | 'gc1',
  response: ByokStructuredResult,
) {
  try {
    await markDeepBuildStageSucceeded(db, jobId, stage, {
      artifact,
      artifactFingerprint: fingerprintDeepBuildArtifact(prefix, artifact),
      usage: response.usage,
      actualModel: response.actualModel,
    });
  } catch {
    throw new ByokProviderError(
      '模型回答已经收到，但阶段产物未能安全保存；本次可能已经计费，不会自动重试',
      'deep_artifact_persist_failed',
      true,
    );
  }
}

function validateReceivedArtifact<T>(validate: () => T, stage: DeepBuildStage): T {
  try {
    return validate();
  } catch (error) {
    const detail = error instanceof DeepBuildValidationError
      ? error.issues.slice(0, 5).join('；')
      : error instanceof Error
        ? error.message
        : '';
    throw new ByokProviderError(
      `模型已经回答，但${DEEP_BUILD_STAGE_LABELS[stage]}没有通过结构校验`
        + `${detail ? `：${detail}` : ''}；可能已经产生费用，本次不会自动重试`,
      `invalid_provider_output_${stage}`,
      true,
    );
  }
}

function composeGraphCompilationArtifact(
  value: unknown,
  dossier: KnowledgeDossier,
  teachingPlan: TeachingPlan,
) {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'learningExpansion' in value
  ) {
    return validateReceivedArtifact(
      () => validateGraphCompilationArtifact(value, dossier, teachingPlan),
      'graph_compilation',
    );
  }
  return validateReceivedArtifact(
    () => composeGraphCompilation(value, dossier, teachingPlan),
    'graph_compilation',
  );
}

function validateGraphCompilationArtifact(
  value: unknown,
  dossier: KnowledgeDossier,
  teachingPlan: TeachingPlan,
) {
  return composeGraphCompilation({
    ...(value as Record<string, unknown>),
    summary: (value as GraphCompilation).learningExpansion.patch.summary,
    nodes: (value as GraphCompilation).learningExpansion.patch.nodes.map((node) => ({
      ...node,
      importanceReason: (value as GraphCompilation).learningExpansion.keyPoints
        .find((point) => point.title === node.title)?.importanceReason,
    })),
    edges: (value as GraphCompilation).learningExpansion.patch.edges,
  }, dossier, teachingPlan);
}

function deepBuildFailure(error: unknown) {
  if (error instanceof ByokProviderError) {
    return { code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown };
  }
  return {
    code: 'deep_build_internal_error',
    message: error instanceof Error ? error.message : '深入构建发生未知错误',
    outcomeUnknown: false,
  };
}

function sumStageUsage(values: Array<string | null>): ByokUsage | null {
  let sawUsage = false;
  const total: ByokUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const value of values) {
    if (!value) continue;
    try {
      const usage = JSON.parse(value) as Partial<ByokUsage> | null;
      if (
        usage
        && Number.isInteger(usage.inputTokens)
        && Number.isInteger(usage.outputTokens)
        && Number.isInteger(usage.totalTokens)
      ) {
        total.inputTokens += usage.inputTokens!;
        total.outputTokens += usage.outputTokens!;
        total.totalTokens += usage.totalTokens!;
        sawUsage = true;
      }
    } catch {
      // Invalid usage metadata never invalidates a verified learning artifact.
    }
  }
  return sawUsage ? total : null;
}

function classifyFailure(error: unknown) {
  if (error instanceof ByokProviderError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof AiGatewayError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof GraphPatchValidationError) {
    return { code: 'invalid_graph_patch', message: error.message, retryable: false };
  }
  const message = error instanceof Error ? error.message : '未知错误';
  return { code: 'internal_error', message, retryable: false };
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
