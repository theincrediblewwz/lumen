import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import {
  APP_BACKUP_FORMAT,
  APP_BACKUP_VERSION,
  BACKUP_PROGRESS_TOTAL,
  nextLocalBackupSlot,
  writeLocalBackupSnapshot,
  type BackupFileStore,
  type LocalBackupSlot,
  type LocalBackupSnapshot,
} from '@/data/local-backup-format';
import { createPortableManifest, type PortableGraphManifest } from '@/data/portable-knowledge';
import { listPromptTemplates } from '@/data/prompt-templates';
import type { NodeAnswer } from '@/types/domain';

const { StorageAccessFramework } = FileSystem;

export { APP_BACKUP_FORMAT, APP_BACKUP_VERSION, BACKUP_PROGRESS_TOTAL };
export { nextLocalBackupSlot, writeLocalBackupSnapshot };
export type { BackupFileStore, LocalBackupSlot, LocalBackupSnapshot };
const MAX_BACKUP_PROJECTS = 100;
const MAX_BACKUP_JSON_CHARS = 64_000_000;

export type LocalBackupJobStatus = 'idle' | 'pending' | 'running' | 'failed' | 'synced';

export type LocalBackupStatus = {
  enabled: boolean;
  directoryUri: string | null;
  activeSlot: LocalBackupSlot | null;
  status: LocalBackupJobStatus;
  revision: number;
  syncedRevision: number;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
};

type ClaimedBackup = {
  directoryUri: string;
  targetRevision: number;
  previousSlot: LocalBackupSlot | null;
  nextSlot: LocalBackupSlot;
};

type BackupStatusRow = {
  directory_uri: string | null;
  enabled: number;
  active_slot: LocalBackupSlot | null;
  status: LocalBackupJobStatus;
  revision: number;
  synced_revision: number;
  progress_current: number;
  progress_total: number;
  progress_label: string | null;
  requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

let workerBusy = false;

export async function getLocalBackupStatus(db: SQLiteDatabase): Promise<LocalBackupStatus> {
  const row = await db.getFirstAsync<BackupStatusRow>(`
    SELECT settings.directory_uri, settings.enabled, settings.active_slot,
           jobs.status, jobs.revision, jobs.synced_revision,
           jobs.progress_current, jobs.progress_total, jobs.progress_label,
           jobs.requested_at, jobs.started_at, jobs.completed_at, jobs.last_error
    FROM local_backup_settings AS settings
    JOIN local_backup_jobs AS jobs ON jobs.id = settings.id
    WHERE settings.id = 1
  `);
  if (!row) throw new Error('本地备份状态尚未初始化');
  return {
    enabled: row.enabled === 1,
    directoryUri: row.directory_uri,
    activeSlot: row.active_slot,
    status: row.status,
    revision: row.revision,
    syncedRevision: row.synced_revision,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    progressLabel: row.progress_label,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

export async function chooseLocalBackupDirectory(db: SQLiteDatabase) {
  assertAndroid();
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE local_backup_settings
       SET directory_uri = ?, enabled = 1, updated_at = ?
       WHERE id = 1`,
      permission.directoryUri,
      now,
    );
    await transaction.runAsync(
      `UPDATE local_backup_jobs
       SET revision = revision + 1, status = 'pending', requested_at = ?,
           progress_current = 0, progress_total = ?, progress_label = '等待首次备份',
           last_error = NULL
       WHERE id = 1`,
      now,
      BACKUP_PROGRESS_TOTAL,
    );
  });
  return getLocalBackupStatus(db);
}

export async function disableLocalBackup(db: SQLiteDatabase) {
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'UPDATE local_backup_settings SET enabled = 0, updated_at = ? WHERE id = 1',
      now,
    );
    await transaction.runAsync(
      `UPDATE local_backup_jobs
       SET status = 'idle', target_revision = NULL, progress_current = 0,
           progress_label = NULL, last_error = NULL
       WHERE id = 1`,
    );
  });
  return getLocalBackupStatus(db);
}

export async function retryLocalBackup(db: SQLiteDatabase) {
  const status = await getLocalBackupStatus(db);
  if (!status.enabled || !status.directoryUri) throw new Error('请先选择自动备份文件夹');
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE local_backup_jobs
     SET revision = revision + 1, status = 'pending', requested_at = ?,
         progress_current = 0, progress_label = '等待重试', last_error = NULL
     WHERE id = 1`,
    now,
  );
  return getLocalBackupStatus(db);
}

export async function runPendingLocalBackup(db: SQLiteDatabase): Promise<LocalBackupStatus | null> {
  if (workerBusy) return null;
  workerBusy = true;
  let claim: ClaimedBackup | null = null;
  try {
    claim = await claimLocalBackupJob(db);
    if (!claim) return null;
    await updateBackupProgress(db, 1, '正在整理本地项目');
    const snapshot = await createLocalBackupSnapshot(db, claim.targetRevision);
    const selectedStore = createSafFileStore(claim.directoryUri);
    const store = await selectedStore.directory!('LearnStuff-Auto-Backup');
    await writeLocalBackupSnapshot(store, snapshot, claim.nextSlot, (current, label) => (
      updateBackupProgress(db, current, label)
    ));
    await completeLocalBackupJob(db, claim);
    return getLocalBackupStatus(db);
  } catch (error) {
    if (claim) await failLocalBackupJob(db, safeBackupError(error));
    return getLocalBackupStatus(db);
  } finally {
    workerBusy = false;
  }
}

export async function createLocalBackupSnapshot(
  db: SQLiteDatabase,
  revision: number,
): Promise<LocalBackupSnapshot> {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM projects ORDER BY created_at, id');
  if (rows.length > MAX_BACKUP_PROJECTS) throw new Error(`自动备份最多支持 ${MAX_BACKUP_PROJECTS} 个项目`);
  const projects: PortableGraphManifest[] = [];
  for (const row of rows) projects.push(await createPortableManifest(db, row.id));
  const answerRows = await db.getAllAsync<{
    id: string;
    project_id: string;
    node_id: string;
    job_id: string | null;
    question: string;
    body: string;
    adapter: NodeAnswer['adapter'];
    actual_model: string | null;
    is_saved: number;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM node_answers ORDER BY created_at, id');
  const topics = await db.getAllAsync<{
    id: string;
    parent_id: string | null;
    title: string;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM topics ORDER BY created_at, id');
  const understandingDocuments = await db.getAllAsync<{
    id: string;
    scope_type: 'global' | 'topic' | 'project';
    scope_id: string;
    category: 'preference' | 'known' | 'pending';
    title: string;
    body: string;
    enabled: number;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM ai_understanding_documents ORDER BY created_at, id');
  const projectScopeSettings = await db.getAllAsync<{
    project_id: string;
    scope_type: 'global' | 'topic' | 'project';
    scope_id: string;
    enabled: number;
    updated_at: string;
  }>('SELECT * FROM project_ai_scope_settings ORDER BY project_id, scope_type, scope_id');
  const favorites = await db.getAllAsync<{
    id: string;
    target_type: 'node' | 'answer';
    target_id: string;
    project_id: string;
    node_id: string;
    created_at: string;
  }>('SELECT * FROM favorites ORDER BY created_at, id');
  const favoriteBindings = await db.getAllAsync<{
    scope_type: 'global' | 'topic' | 'project';
    scope_id: string;
    favorite_id: string;
    created_at: string;
  }>('SELECT * FROM favorite_bindings ORDER BY scope_type, scope_id, favorite_id');
  const snapshot: LocalBackupSnapshot = {
    format: APP_BACKUP_FORMAT,
    version: APP_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    revision,
    projects,
    answers: answerRows.map((answer) => ({
      id: answer.id,
      projectId: answer.project_id,
      nodeId: answer.node_id,
      jobId: answer.job_id,
      question: answer.question,
      body: answer.body,
      adapter: answer.adapter,
      actualModel: answer.actual_model,
      saved: answer.is_saved === 1,
      createdAt: answer.created_at,
      updatedAt: answer.updated_at,
    })),
    promptTemplates: await listPromptTemplates(db),
    topics: topics.map((topic) => ({
      id: topic.id,
      parentId: topic.parent_id,
      title: topic.title,
      createdAt: topic.created_at,
      updatedAt: topic.updated_at,
    })),
    aiUnderstandingDocuments: understandingDocuments.map((document) => ({
      id: document.id,
      scopeType: document.scope_type,
      scopeId: document.scope_id,
      category: document.category,
      title: document.title,
      body: document.body,
      enabled: document.enabled === 1,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    })),
    projectAiScopeSettings: projectScopeSettings.map((setting) => ({
      projectId: setting.project_id,
      scopeType: setting.scope_type,
      scopeId: setting.scope_id,
      enabled: setting.enabled === 1,
      updatedAt: setting.updated_at,
    })),
    favorites: favorites.map((favorite) => ({
      id: favorite.id,
      targetType: favorite.target_type,
      targetId: favorite.target_id,
      projectId: favorite.project_id,
      nodeId: favorite.node_id,
      createdAt: favorite.created_at,
    })),
    favoriteBindings: favoriteBindings.map((binding) => ({
      scopeType: binding.scope_type,
      scopeId: binding.scope_id,
      favoriteId: binding.favorite_id,
      createdAt: binding.created_at,
    })),
    exclusions: [
      'BYOK API keys',
      'Gateway access tokens',
      'AI data-consent records',
      'SecureStore and environment secrets',
    ],
  };
  const serializedLength = JSON.stringify(snapshot).length;
  if (serializedLength > MAX_BACKUP_JSON_CHARS) throw new Error('自动备份内容超过 64 MB 上限，请改用单项目主动导出');
  return snapshot;
}

async function claimLocalBackupJob(db: SQLiteDatabase): Promise<ClaimedBackup | null> {
  let claim: ClaimedBackup | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<{
      directory_uri: string | null;
      enabled: number;
      active_slot: LocalBackupSlot | null;
      status: LocalBackupJobStatus;
      revision: number;
      synced_revision: number;
    }>(`
      SELECT settings.directory_uri, settings.enabled, settings.active_slot,
             jobs.status, jobs.revision, jobs.synced_revision
      FROM local_backup_settings AS settings
      JOIN local_backup_jobs AS jobs ON jobs.id = settings.id
      WHERE settings.id = 1
    `);
    if (!row?.enabled || !row.directory_uri || row.status !== 'pending' || row.revision <= row.synced_revision) return;
    const now = new Date().toISOString();
    const nextSlot = nextLocalBackupSlot(row.active_slot);
    const result = await transaction.runAsync(
      `UPDATE local_backup_jobs
       SET status = 'running', target_revision = revision, started_at = ?,
           progress_current = 0, progress_total = ?, progress_label = '准备自动备份',
           last_error = NULL
       WHERE id = 1 AND status = 'pending' AND revision = ?`,
      now,
      BACKUP_PROGRESS_TOTAL,
      row.revision,
    );
    if (result.changes !== 1) return;
    claim = {
      directoryUri: row.directory_uri,
      targetRevision: row.revision,
      previousSlot: row.active_slot,
      nextSlot,
    };
  });
  return claim;
}

async function completeLocalBackupJob(db: SQLiteDatabase, claim: ClaimedBackup) {
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<{ revision: number }>(
      'SELECT revision FROM local_backup_jobs WHERE id = 1',
    );
    const hasNewerRevision = (row?.revision ?? claim.targetRevision) > claim.targetRevision;
    await transaction.runAsync(
      `UPDATE local_backup_settings
       SET active_slot = ?, updated_at = ?
       WHERE id = 1`,
      claim.nextSlot,
      now,
    );
    await transaction.runAsync(
      `UPDATE local_backup_jobs
       SET status = ?, synced_revision = ?, target_revision = NULL,
           progress_current = ?, progress_total = ?, progress_label = ?,
           completed_at = ?, last_error = NULL
       WHERE id = 1`,
      hasNewerRevision ? 'pending' : 'synced',
      claim.targetRevision,
      BACKUP_PROGRESS_TOTAL,
      BACKUP_PROGRESS_TOTAL,
      hasNewerRevision ? '发现新改动，等待下一轮' : '已备份到本地文件夹',
      now,
    );
  });
}

async function failLocalBackupJob(db: SQLiteDatabase, message: string) {
  await db.runAsync(
    `UPDATE local_backup_jobs
     SET status = 'failed', target_revision = NULL, progress_label = '备份失败',
         last_error = ?
     WHERE id = 1`,
    message,
  );
}

async function updateBackupProgress(db: SQLiteDatabase, current: number, label: string) {
  await db.runAsync(
    `UPDATE local_backup_jobs
     SET progress_current = ?, progress_total = ?, progress_label = ?
     WHERE id = 1 AND status = 'running'`,
    current,
    BACKUP_PROGRESS_TOTAL,
    label,
  );
}

function createSafFileStore(directoryUri: string): BackupFileStore {
  return {
    async write(fileName, mimeType, contents) {
      const entries = await StorageAccessFramework.readDirectoryAsync(directoryUri);
      const existing = entries.find((uri) => safName(uri) === fileName);
      const uri = existing ?? await StorageAccessFramework.createFileAsync(directoryUri, fileName, mimeType);
      await StorageAccessFramework.writeAsStringAsync(uri, contents);
    },
    async directory(directoryName) {
      const entries = await StorageAccessFramework.readDirectoryAsync(directoryUri);
      const existing = entries.find((uri) => safName(uri) === directoryName);
      const childUri = existing ?? await StorageAccessFramework.makeDirectoryAsync(directoryUri, directoryName);
      return createSafFileStore(childUri);
    },
  };
}

function safName(uri: string) {
  try {
    const decoded = decodeURIComponent(uri);
    const tail = decoded.split('/').filter(Boolean).at(-1) ?? '';
    return tail.includes(':') ? tail.split(':').at(-1) ?? tail : tail;
  } catch {
    return '';
  }
}

function safeBackupError(error: unknown) {
  const message = error instanceof Error ? error.message : '本地文件夹写入失败';
  return message.replace(/content:\/\/[^\s)]+/gi, '所选文件夹').slice(0, 500);
}

function assertAndroid() {
  if (Platform.OS !== 'android') throw new Error('本地自动备份当前仅支持 Android');
}
