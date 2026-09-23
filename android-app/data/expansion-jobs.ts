import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  DeepBuildStage,
  DeepBuildStageStatus,
  ExpansionQualityPath,
} from '@/ai/deep-build';
import type { ContextPlan } from '@/ai/context-plan';
import type { ExpansionContext, GraphPatch } from '@/ai/graph-patch';

export type ExpansionAdapter = 'local' | 'gateway' | 'byok';
export type ExpansionJobStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed';

export type ExpansionJob = {
  id: string;
  projectId: string;
  selectionId: string;
  prompt: string;
  adapter: ExpansionAdapter;
  qualityPath: ExpansionQualityPath;
  status: ExpansionJobStatus;
  attemptCount: number;
  requestJson: string;
  contextPlanJson: string | null;
  responseJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  leaseExpiresAt: string | null;
};

type JobRow = {
  id: string;
  project_id: string;
  selection_id: string;
  prompt: string;
  adapter: ExpansionAdapter;
  quality_path: ExpansionQualityPath;
  status: ExpansionJobStatus;
  attempt_count: number;
  request_json: string;
  context_plan_json: string | null;
  response_json: string | null;
  error_code: string | null;
  error_message: string | null;
  next_retry_at: string | null;
  lease_expires_at: string | null;
};

export type PersistedDeepBuildStage = {
  jobId: string;
  stage: DeepBuildStage;
  stageOrder: number;
  status: DeepBuildStageStatus;
  requestId: string | null;
  attemptCount: number;
  artifactJson: string | null;
  artifactFingerprint: string | null;
  usageJson: string | null;
  actualModel: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type DeepBuildStageRow = {
  job_id: string;
  stage: DeepBuildStage;
  stage_order: number;
  status: DeepBuildStageStatus;
  request_id: string | null;
  attempt_count: number;
  artifact_json: string | null;
  artifact_fingerprint: string | null;
  usage_json: string | null;
  actual_model: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

const DEEP_BUILD_STAGE_ORDER: DeepBuildStage[] = [
  'knowledge_dossier',
  'teaching_plan',
  'graph_compilation',
];

export async function createExpansionJob(
  db: SQLiteDatabase,
  context: ExpansionContext,
  adapter: ExpansionAdapter,
  qualityPath: ExpansionQualityPath = 'quick',
) {
  const active = await findActiveExpansionJob(db, context.project.id, context.selection.id);
  if (active) throw new Error('这个知识点已有一个展开任务正在执行或等待恢复');
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO ai_expansion_jobs
        (id, project_id, selection_type, selection_id, prompt, adapter, quality_path, status,
         attempt_count, request_json, created_at, updated_at)
       VALUES (?, ?, 'node', ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      context.requestId,
      context.project.id,
      context.selection.id,
      context.prompt,
      adapter,
      qualityPath,
      JSON.stringify(context),
      now,
      now,
    );
    if (qualityPath === 'deep') {
      for (const [index, stage] of DEEP_BUILD_STAGE_ORDER.entries()) {
        await transaction.runAsync(
          `INSERT INTO ai_deep_build_stages
            (job_id, stage, stage_order, status, attempt_count, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?)`,
          context.requestId,
          stage,
          index + 1,
          now,
        );
      }
    }
  });
  return context.requestId;
}

export async function findActiveExpansionJob(
  db: SQLiteDatabase,
  projectId: string,
  selectionId: string,
): Promise<ExpansionJob | null> {
  const row = await db.getFirstAsync<JobRow>(
    `SELECT * FROM ai_expansion_jobs
     WHERE project_id = ? AND selection_id = ? AND status IN ('queued', 'running', 'retry_wait')
     ORDER BY created_at DESC LIMIT 1`,
    projectId,
    selectionId,
  );
  return row ? mapJob(row) : null;
}

export async function claimExpansionJob(
  db: SQLiteDatabase,
  jobId: string,
  leaseDurationMs = 2 * 60_000,
) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  const result = await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'running', attempt_count = attempt_count + 1, lease_expires_at = ?,
         next_retry_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ? AND (
       status = 'queued' OR
       (status = 'retry_wait' AND (next_retry_at IS NULL OR next_retry_at <= ?))
     )`,
    leaseExpiresAt,
    now.toISOString(),
    jobId,
    now.toISOString(),
  );
  if (result.changes !== 1) throw new Error('展开任务无法取得执行租约');
  return getExpansionJob(db, jobId);
}

export async function markExpansionRetry(
  db: SQLiteDatabase,
  jobId: string,
  code: string,
  message: string,
  delayMs: number,
) {
  const now = new Date();
  await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'retry_wait', error_code = ?, error_message = ?, next_retry_at = ?,
         lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'running'`,
    code,
    message,
    new Date(now.getTime() + delayMs).toISOString(),
    now.toISOString(),
    jobId,
  );
}

export async function markExpansionFailed(
  db: SQLiteDatabase,
  jobId: string,
  code: string,
  message: string,
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'failed', error_code = ?, error_message = ?, lease_expires_at = NULL,
         next_retry_at = NULL, updated_at = ?
     WHERE id = ?`,
    code,
    message,
    now,
    jobId,
  );
}

export async function markExpansionSucceededInTransaction(
  transaction: SQLiteDatabase,
  jobId: string,
  patch: GraphPatch,
) {
  const now = new Date().toISOString();
  const result = await transaction.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'succeeded', response_json = ?, error_code = NULL, error_message = NULL,
         lease_expires_at = NULL, next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'running'`,
    JSON.stringify(patch),
    now,
    jobId,
  );
  if (result.changes !== 1) {
    throw new Error('展开任务已失去执行租约，拒绝提交图谱变更');
  }
}

export async function recoverStaleExpansionJobs(db: SQLiteDatabase) {
  const now = new Date().toISOString();
  const uncertainStage = await db.runAsync(
    `UPDATE ai_deep_build_stages
     SET status = 'unknown_charge', completed_at = ?, updated_at = ?,
         error_code = 'provider_outcome_unknown',
         error_message = '上次深入构建请求被中断，是否已计费不确定；不会自动重试'
     WHERE status = 'running' AND EXISTS (
       SELECT 1 FROM ai_expansion_jobs job
       WHERE job.id = ai_deep_build_stages.job_id
         AND job.adapter = 'byok' AND job.status = 'running'
         AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at <= ?
     )`,
    now,
    now,
    now,
  );
  const uncertain = await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'failed', lease_expires_at = NULL, next_retry_at = NULL,
         error_code = 'provider_outcome_unknown',
         error_message = '上次个人 AI 请求被中断，是否已计费不确定；不会自动重试', updated_at = ?
     WHERE adapter = 'byok' AND status = 'running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    now,
    now,
  );
  const stale = await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'queued', lease_expires_at = NULL, error_code = 'worker_interrupted',
         error_message = '上次展开被中断，已排队等待恢复', updated_at = ?
     WHERE adapter != 'byok' AND status = 'running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    now,
    now,
  );
  const due = await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'queued', next_retry_at = NULL, updated_at = ?
     WHERE status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`,
    now,
    now,
  );
  return uncertainStage.changes + uncertain.changes + stale.changes + due.changes;
}

export async function readExpansionContextPlan(
  db: SQLiteDatabase,
  jobId: string,
): Promise<ContextPlan | null> {
  const row = await db.getFirstAsync<{ context_plan_json: string | null }>(
    'SELECT context_plan_json FROM ai_expansion_jobs WHERE id = ?',
    jobId,
  );
  if (!row?.context_plan_json) return null;
  try {
    return JSON.parse(row.context_plan_json) as ContextPlan;
  } catch {
    throw new Error('已保存的上下文计划损坏，请重新发起问题');
  }
}

export async function saveExpansionContextPlan(
  db: SQLiteDatabase,
  jobId: string,
  plan: ContextPlan,
) {
  const result = await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET context_plan_json = ?, updated_at = ?
     WHERE id = ? AND context_plan_json IS NULL`,
    JSON.stringify(plan),
    new Date().toISOString(),
    jobId,
  );
  if (result.changes === 1) return plan;
  const saved = await readExpansionContextPlan(db, jobId);
  if (!saved) throw new Error('上下文计划没有成功保存');
  return saved;
}

export async function findDeepBuildResumeCandidate(
  db: SQLiteDatabase,
  projectId: string,
  selectionId: string,
  prompt: string,
): Promise<ExpansionJob | null> {
  const row = await db.getFirstAsync<JobRow>(
    `SELECT job.*
     FROM ai_expansion_jobs job
     WHERE job.project_id = ? AND job.selection_id = ? AND job.prompt = ?
       AND job.adapter = 'byok' AND job.quality_path = 'deep' AND job.status = 'failed'
       AND NOT EXISTS (
         SELECT 1 FROM ai_deep_build_stages stage
         WHERE stage.job_id = job.id AND stage.status = 'unknown_charge'
       )
     ORDER BY job.created_at DESC LIMIT 1`,
    projectId,
    selectionId,
    prompt,
  );
  return row ? mapJob(row) : null;
}

export async function listDeepBuildStages(
  db: SQLiteDatabase,
  jobId: string,
): Promise<PersistedDeepBuildStage[]> {
  const rows = await db.getAllAsync<DeepBuildStageRow>(
    `SELECT * FROM ai_deep_build_stages
     WHERE job_id = ? ORDER BY stage_order ASC`,
    jobId,
  );
  return rows.map(mapDeepBuildStage);
}

export async function prepareDeepBuildRetry(db: SQLiteDatabase, jobId: string) {
  const stages = await listDeepBuildStages(db, jobId);
  if (stages.some((stage) => stage.status === 'unknown_charge')) {
    throw new Error('费用状态不明的深入构建不能重试');
  }
  if (stages.length !== 3 || stages.some((stage) => stage.status === 'running')) {
    throw new Error('深入构建阶段状态不完整，不能继续');
  }
  const failed = stages.find((stage) => stage.status === 'failed');
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    if (failed) {
      const stageResult = await transaction.runAsync(
        `UPDATE ai_deep_build_stages
         SET status = 'pending', request_id = NULL, error_code = NULL, error_message = NULL,
             started_at = NULL, completed_at = NULL, updated_at = ?
         WHERE job_id = ? AND stage = ? AND status = 'failed'`,
        now,
        jobId,
        failed.stage,
      );
      if (stageResult.changes !== 1) throw new Error('深入构建失败阶段已经变化');
    }
    const jobResult = await transaction.runAsync(
      `UPDATE ai_expansion_jobs
       SET status = 'queued', error_code = NULL, error_message = NULL,
           next_retry_at = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
      now,
      jobId,
    );
    if (jobResult.changes !== 1) throw new Error('深入构建任务已经变化');
  });
}

export async function claimDeepBuildStage(
  db: SQLiteDatabase,
  jobId: string,
  stage: DeepBuildStage,
  requestId: string,
) {
  const now = new Date().toISOString();
  const result = await db.runAsync(
    `UPDATE ai_deep_build_stages
     SET status = 'running', request_id = ?, attempt_count = attempt_count + 1,
         error_code = NULL, error_message = NULL, started_at = ?,
         completed_at = NULL, updated_at = ?
     WHERE job_id = ? AND stage = ? AND status = 'pending'`,
    requestId,
    now,
    now,
    jobId,
    stage,
  );
  if (result.changes !== 1) throw new Error('深入构建阶段无法取得执行权');
  return getDeepBuildStage(db, jobId, stage);
}

export async function markDeepBuildStageSucceeded(
  db: SQLiteDatabase,
  jobId: string,
  stage: DeepBuildStage,
  input: {
    artifact: unknown;
    artifactFingerprint: string;
    usage: unknown;
    actualModel: string;
  },
) {
  const now = new Date().toISOString();
  const result = await db.runAsync(
    `UPDATE ai_deep_build_stages
     SET status = 'succeeded', artifact_json = ?, artifact_fingerprint = ?,
         usage_json = ?, actual_model = ?, error_code = NULL, error_message = NULL,
         completed_at = ?, updated_at = ?
     WHERE job_id = ? AND stage = ? AND status = 'running'`,
    JSON.stringify(input.artifact),
    input.artifactFingerprint,
    JSON.stringify(input.usage),
    input.actualModel,
    now,
    now,
    jobId,
    stage,
  );
  if (result.changes !== 1) throw new Error('深入构建阶段已经变化，拒绝保存结果');
}

export async function markDeepBuildStageFailed(
  db: SQLiteDatabase,
  jobId: string,
  stage: DeepBuildStage,
  input: {
    code: string;
    message: string;
    outcomeUnknown: boolean;
    rejectedOutput?: unknown;
    usage?: unknown;
    actualModel?: string;
  },
) {
  const now = new Date().toISOString();
  const stageStatus: DeepBuildStageStatus = input.outcomeUnknown ? 'unknown_charge' : 'failed';
  const rejectedOutputJson = input.rejectedOutput === undefined
    ? null
    : JSON.stringify({
      kind: 'rejected_provider_output',
      value: input.rejectedOutput,
    });
  const usageJson = input.usage === undefined ? null : JSON.stringify(input.usage);
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const stageResult = await transaction.runAsync(
      `UPDATE ai_deep_build_stages
       SET status = ?, error_code = ?, error_message = ?,
           artifact_json = COALESCE(?, artifact_json), artifact_fingerprint = NULL,
           usage_json = COALESCE(?, usage_json), actual_model = COALESCE(?, actual_model),
           completed_at = ?, updated_at = ?
       WHERE job_id = ? AND stage = ? AND status = 'running'`,
      stageStatus,
      input.code,
      input.message,
      rejectedOutputJson,
      usageJson,
      input.actualModel ?? null,
      now,
      now,
      jobId,
      stage,
    );
    if (stageResult.changes !== 1) throw new Error('深入构建阶段已经变化');
    await transaction.runAsync(
      `UPDATE ai_expansion_jobs
       SET status = 'failed', error_code = ?, error_message = ?,
           lease_expires_at = NULL, next_retry_at = NULL, updated_at = ?
       WHERE id = ?`,
      input.code,
      input.message,
      now,
      jobId,
    );
  });
}

export function readDeepBuildArtifact<T>(stage: PersistedDeepBuildStage): T | null {
  if (stage.status !== 'succeeded' || !stage.artifactJson) return null;
  return JSON.parse(stage.artifactJson) as T;
}

export async function getExpansionJob(db: SQLiteDatabase, id: string): Promise<ExpansionJob> {
  const row = await db.getFirstAsync<JobRow>('SELECT * FROM ai_expansion_jobs WHERE id = ?', id);
  if (!row) throw new Error('展开任务不存在');
  return mapJob(row);
}

export async function getLatestExpansionJobForProject(db: SQLiteDatabase, projectId: string): Promise<ExpansionJob | null> {
  const row = await db.getFirstAsync<JobRow>(
    'SELECT * FROM ai_expansion_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
    projectId,
  );
  return row ? mapJob(row) : null;
}

function mapJob(row: JobRow): ExpansionJob {
  return {
    id: row.id,
    projectId: row.project_id,
    selectionId: row.selection_id,
    prompt: row.prompt,
    adapter: row.adapter,
    qualityPath: row.quality_path ?? 'quick',
    status: row.status,
    attemptCount: row.attempt_count,
    requestJson: row.request_json,
    contextPlanJson: row.context_plan_json,
    responseJson: row.response_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    nextRetryAt: row.next_retry_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

async function getDeepBuildStage(
  db: SQLiteDatabase,
  jobId: string,
  stage: DeepBuildStage,
): Promise<PersistedDeepBuildStage> {
  const row = await db.getFirstAsync<DeepBuildStageRow>(
    'SELECT * FROM ai_deep_build_stages WHERE job_id = ? AND stage = ?',
    jobId,
    stage,
  );
  if (!row) throw new Error('深入构建阶段不存在');
  return mapDeepBuildStage(row);
}

function mapDeepBuildStage(row: DeepBuildStageRow): PersistedDeepBuildStage {
  return {
    jobId: row.job_id,
    stage: row.stage,
    stageOrder: row.stage_order,
    status: row.status,
    requestId: row.request_id,
    attemptCount: row.attempt_count,
    artifactJson: row.artifact_json,
    artifactFingerprint: row.artifact_fingerprint,
    usageJson: row.usage_json,
    actualModel: row.actual_model,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}
