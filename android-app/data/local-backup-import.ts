import type { SQLiteDatabase } from 'expo-sqlite';

import {
  APP_BACKUP_FORMAT,
  type LocalBackupSnapshot,
} from '@/data/local-backup-format';
import { insertNodeAnswerInTransaction } from '@/data/node-answers';
import {
  importPortableManifestWithMapping,
  validatePortableManifest,
  type PortableImportMapping,
} from '@/data/portable-knowledge';

const MAX_BACKUP_CHARS = 64_000_000;
const MAX_PROJECTS = 100;
const MAX_ANSWERS = 20_000;
const MAX_TEMPLATES = 500;
const MAX_TOPICS = 2_000;
const MAX_UNDERSTANDING_DOCUMENTS = 5_000;
const MAX_SCOPE_SETTINGS = 20_000;
const MAX_FAVORITES = 20_000;
const MAX_BINDINGS = 40_000;

export type LocalBackupImportProgress = {
  current: number;
  total: number;
  label: string;
};

export type LocalBackupImportResult = {
  projectIds: string[];
  projectCount: number;
  sourceVersion: 2 | 3 | 4;
  importedTopicCount: number;
  importedFavoriteCount: number;
};

export async function pickLocalBackupSnapshot(): Promise<LocalBackupSnapshot | null> {
  const [DocumentPicker, FileSystem] = await Promise.all([
    import('expo-document-picker'),
    import('expo-file-system/legacy'),
  ]);
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/json', 'text/plain'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if ((asset.size ?? 0) > MAX_BACKUP_CHARS) throw new Error('备份 JSON 超过 64 MB 上限');
  const raw = await FileSystem.readAsStringAsync(asset.uri);
  return parseLocalBackupSnapshot(raw);
}

export function parseLocalBackupSnapshot(raw: string): LocalBackupSnapshot {
  if (raw.length > MAX_BACKUP_CHARS) throw new Error('备份 JSON 超过 64 MB 上限');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('所选文件不是有效 JSON');
  }
  const root = objectValue(value, '备份');
  if (root.format !== APP_BACKUP_FORMAT || (root.version !== 2 && root.version !== 3 && root.version !== 4)) {
    throw new Error('请选择 LearnStuff 自动备份 v2、v3 或 v4 的槽位 JSON');
  }
  const projects = arrayValue(root.projects, '项目', MAX_PROJECTS).map(validatePortableManifest);
  if (root.version === 4 && projects.some((project) => project.version !== 3 || !project.fusion)) throw new Error('v4 备份缺少对话与阅读资料，请选择完整备份');
  const answers = arrayValue(root.answers ?? [], '回答', MAX_ANSWERS).map((value, index) => {
    const row = objectValue(value, `回答 ${index + 1}`);
    return {
      id: stringValue(row.id, '回答 ID', 160),
      projectId: stringValue(row.projectId, '回答项目 ID', 160),
      nodeId: stringValue(row.nodeId, '回答节点 ID', 160),
      jobId: nullableStringValue(row.jobId, '回答任务 ID', 160),
      question: stringValue(row.question, '问题', 4_000),
      body: bodyValue(row.body, '回答正文'),
      adapter: enumValue(row.adapter, ['local', 'gateway', 'byok', 'imported'] as const, '回答来源'),
      actualModel: nullableStringValue(row.actualModel, '回答模型', 300),
      saved: booleanValue(row.saved, '回答收藏状态'),
      createdAt: stringValue(row.createdAt, '回答创建时间', 80),
      updatedAt: stringValue(row.updatedAt, '回答更新时间', 80),
    };
  });
  const promptTemplates = arrayValue(root.promptTemplates ?? [], '询问模板', MAX_TEMPLATES).map((value, index) => {
    const row = objectValue(value, `询问模板 ${index + 1}`);
    return {
      id: stringValue(row.id, '模板 ID', 160),
      title: stringValue(row.title, '模板标题', 80),
      body: stringValue(row.body, '模板正文', 4_000),
      order: integerValue(row.order, '模板顺序', 0, 1_000_000),
      createdAt: stringValue(row.createdAt, '模板创建时间', 80),
      updatedAt: stringValue(row.updatedAt, '模板更新时间', 80),
    };
  });
  const topics = arrayValue(root.topics ?? [], '专题', MAX_TOPICS).map((value, index) => {
    const row = objectValue(value, `专题 ${index + 1}`);
    return {
      id: stringValue(row.id, '专题 ID', 160),
      parentId: nullableStringValue(row.parentId, '上级专题 ID', 160),
      title: stringValue(row.title, '专题标题', 200),
      createdAt: stringValue(row.createdAt, '专题创建时间', 80),
      updatedAt: stringValue(row.updatedAt, '专题更新时间', 80),
    };
  });
  const topicIds = new Set(topics.map((topic) => topic.id));
  for (const topic of topics) {
    if (topic.parentId && !topicIds.has(topic.parentId)) throw new Error(`专题“${topic.title}”的上级不存在`);
    if (topic.parentId === topic.id) throw new Error(`专题“${topic.title}”不能把自己作为上级`);
  }
  const aiUnderstandingDocuments = arrayValue(
    root.aiUnderstandingDocuments ?? [],
    'AI 了解文档',
    MAX_UNDERSTANDING_DOCUMENTS,
  ).map((value, index) => {
    const row = objectValue(value, `AI 了解文档 ${index + 1}`);
    return {
      id: stringValue(row.id, '了解文档 ID', 160),
      scopeType: enumValue(row.scopeType, ['global', 'topic', 'project'] as const, '了解文档层级'),
      scopeId: stringValue(row.scopeId, '了解文档层级 ID', 160),
      category: enumValue(row.category, ['preference', 'known', 'pending'] as const, '了解文档分类'),
      title: stringValue(row.title, '了解文档标题', 200),
      body: bodyValue(row.body, '了解文档正文'),
      enabled: booleanValue(row.enabled, '了解文档启用状态'),
      createdAt: stringValue(row.createdAt, '了解文档创建时间', 80),
      updatedAt: stringValue(row.updatedAt, '了解文档更新时间', 80),
    };
  });
  const projectAiScopeSettings = arrayValue(
    root.projectAiScopeSettings ?? [],
    '项目了解层级设置',
    MAX_SCOPE_SETTINGS,
  ).map((value, index) => {
    const row = objectValue(value, `项目了解层级设置 ${index + 1}`);
    return {
      projectId: stringValue(row.projectId, '项目 ID', 160),
      scopeType: enumValue(row.scopeType, ['global', 'topic', 'project'] as const, '了解层级'),
      scopeId: stringValue(row.scopeId, '了解层级 ID', 160),
      enabled: booleanValue(row.enabled, '了解层级启用状态'),
      updatedAt: stringValue(row.updatedAt, '了解层级更新时间', 80),
    };
  });
  const favorites = arrayValue(root.favorites ?? [], '收藏', MAX_FAVORITES).map((value, index) => {
    const row = objectValue(value, `收藏 ${index + 1}`);
    return {
      id: stringValue(row.id, '收藏 ID', 160),
      targetType: enumValue(row.targetType, ['node', 'answer'] as const, '收藏类型'),
      targetId: stringValue(row.targetId, '收藏目标 ID', 160),
      projectId: stringValue(row.projectId, '收藏项目 ID', 160),
      nodeId: stringValue(row.nodeId, '收藏节点 ID', 160),
      createdAt: stringValue(row.createdAt, '收藏时间', 80),
    };
  });
  const favoriteBindings = arrayValue(root.favoriteBindings ?? [], '收藏引用', MAX_BINDINGS).map((value, index) => {
    const row = objectValue(value, `收藏引用 ${index + 1}`);
    return {
      scopeType: enumValue(row.scopeType, ['global', 'topic', 'project'] as const, '收藏引用层级'),
      scopeId: stringValue(row.scopeId, '收藏引用层级 ID', 160),
      favoriteId: stringValue(row.favoriteId, '收藏 ID', 160),
      createdAt: stringValue(row.createdAt, '收藏引用时间', 80),
    };
  });
  return {
    format: APP_BACKUP_FORMAT,
    version: root.version,
    exportedAt: stringValue(root.exportedAt, '备份时间', 80),
    revision: integerValue(root.revision, '备份修订号', 0, Number.MAX_SAFE_INTEGER),
    projects,
    answers,
    promptTemplates,
    topics,
    aiUnderstandingDocuments,
    projectAiScopeSettings,
    favorites,
    favoriteBindings,
    exclusions: arrayValue(root.exclusions ?? [], '排除项', 100)
      .map((item) => stringValue(item, '排除项', 500)),
  };
}

export async function importLocalBackupAsCopies(
  db: SQLiteDatabase,
  snapshotInput: LocalBackupSnapshot,
  onProgress?: (progress: LocalBackupImportProgress) => Promise<void> | void,
): Promise<LocalBackupImportResult> {
  const snapshot = parseLocalBackupSnapshot(JSON.stringify(snapshotInput));
  const total = Math.max(1, snapshot.projects.length + 1);
  const imported: Array<{
    originalProjectId: string;
    originalTopicId: string | null;
    mapping: PortableImportMapping;
  }> = [];
  try {
    for (const [index, project] of snapshot.projects.entries()) {
      await onProgress?.({
        current: index,
        total,
        label: `正在恢复项目 ${index + 1}/${snapshot.projects.length} · ${project.project.title}`,
      });
      const mapping = await importPortableManifestWithMapping(db, project);
      imported.push({
        originalProjectId: project.project.id,
        originalTopicId: project.project.topicId ?? null,
        mapping,
      });
    }
    await onProgress?.({ current: snapshot.projects.length, total, label: '正在恢复专题、AI 了解与收藏索引' });
    const importedFavoriteCount = await restoreBackupMetadata(db, snapshot, imported);
    await onProgress?.({ current: total, total, label: '备份副本恢复完成' });
    return {
      projectIds: imported.map((item) => item.mapping.projectId),
      projectCount: imported.length,
      sourceVersion: snapshot.version,
      importedTopicCount: snapshot.topics.length,
      importedFavoriteCount,
    };
  } catch (error) {
    await cleanupFailedImport(db, imported.map((item) => item.mapping.projectId));
    throw error;
  }
}

async function restoreBackupMetadata(
  db: SQLiteDatabase,
  snapshot: LocalBackupSnapshot,
  imported: Array<{
    originalProjectId: string;
    originalTopicId: string | null;
    mapping: PortableImportMapping;
  }>,
) {
  const projects = new Map(imported.map((item) => [item.originalProjectId, item]));
  const topicIds = new Map(snapshot.topics.map((topic) => [topic.id, createId('topic')]));
  const favoriteIds = new Map<string, string>();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    for (const topic of snapshot.topics) {
      await transaction.runAsync(
        'INSERT INTO topics (id, parent_id, title, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)',
        topicIds.get(topic.id)!,
        topic.title,
        topic.createdAt,
        topic.updatedAt,
      );
    }
    for (const topic of snapshot.topics) {
      if (!topic.parentId) continue;
      await transaction.runAsync(
        'UPDATE topics SET parent_id = ? WHERE id = ?',
        topicIds.get(topic.parentId)!,
        topicIds.get(topic.id)!,
      );
    }
    for (const project of imported) {
      if (!project.originalTopicId) continue;
      const topicId = topicIds.get(project.originalTopicId);
      if (topicId) {
        await transaction.runAsync(
          'UPDATE projects SET topic_id = ? WHERE id = ?',
          topicId,
          project.mapping.projectId,
        );
      }
    }
    for (const answer of snapshot.answers) {
      const project = projects.get(answer.projectId);
      if (!project || project.mapping.answerIds.has(answer.id)) continue;
      const nodeId = project.mapping.nodeIds.get(answer.nodeId);
      if (!nodeId) throw new Error(`旧备份回答“${answer.question.slice(0, 30)}”的节点不存在`);
      const answerId = createId('answer');
      await insertNodeAnswerInTransaction(transaction, {
        id: answerId,
        projectId: project.mapping.projectId,
        nodeId,
        question: answer.question,
        body: answer.body,
        adapter: 'imported',
        actualModel: answer.actualModel,
        saved: answer.saved,
        createdAt: answer.createdAt,
        updatedAt: answer.updatedAt,
      });
      project.mapping.answerIds.set(answer.id, answerId);
    }
    for (const [index, template] of snapshot.promptTemplates.entries()) {
      await transaction.runAsync(
        'INSERT INTO prompt_templates (id, title, body, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        createId('template'),
        template.title,
        template.body,
        template.order + index,
        template.createdAt,
        template.updatedAt,
      );
    }
    for (const document of snapshot.aiUnderstandingDocuments) {
      const scopeId = mapScopeId(document.scopeType, document.scopeId, projects, topicIds);
      if (!scopeId) continue;
      await transaction.runAsync(
        `INSERT OR IGNORE INTO ai_understanding_documents (
          id, scope_type, scope_id, category, title, body, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        createId('understanding'),
        document.scopeType,
        scopeId,
        document.category,
        document.title,
        document.body,
        document.enabled ? 1 : 0,
        document.createdAt,
        document.updatedAt,
      );
    }
    for (const setting of snapshot.projectAiScopeSettings) {
      const project = projects.get(setting.projectId);
      const scopeId = mapScopeId(setting.scopeType, setting.scopeId, projects, topicIds);
      if (!project || !scopeId) continue;
      await transaction.runAsync(
        `INSERT OR REPLACE INTO project_ai_scope_settings (
          project_id, scope_type, scope_id, enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        project.mapping.projectId,
        setting.scopeType,
        scopeId,
        setting.enabled ? 1 : 0,
        setting.updatedAt,
      );
    }
    for (const favorite of snapshot.favorites) {
      const project = projects.get(favorite.projectId);
      if (!project) continue;
      const nodeId = project.mapping.nodeIds.get(favorite.nodeId);
      const targetId = favorite.targetType === 'node'
        ? project.mapping.nodeIds.get(favorite.targetId)
        : project.mapping.answerIds.get(favorite.targetId);
      if (!nodeId || !targetId) throw new Error('旧备份中有无法定位的收藏');
      const existing = await transaction.getFirstAsync<{ id: string }>(
        'SELECT id FROM favorites WHERE target_type = ? AND target_id = ?',
        favorite.targetType,
        targetId,
      );
      const favoriteId = existing?.id ?? createId('favorite');
      if (!existing) {
        await transaction.runAsync(
          `INSERT INTO favorites (
            id, target_type, target_id, project_id, node_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          favoriteId,
          favorite.targetType,
          targetId,
          project.mapping.projectId,
          nodeId,
          favorite.createdAt,
        );
      }
      favoriteIds.set(favorite.id, favoriteId);
    }
    for (const binding of snapshot.favoriteBindings) {
      const favoriteId = favoriteIds.get(binding.favoriteId);
      const scopeId = mapScopeId(binding.scopeType, binding.scopeId, projects, topicIds);
      if (!favoriteId || !scopeId) continue;
      await transaction.runAsync(
        `INSERT OR IGNORE INTO favorite_bindings (
          scope_type, scope_id, favorite_id, created_at
        ) VALUES (?, ?, ?, ?)`,
        binding.scopeType,
        scopeId,
        favoriteId,
        binding.createdAt,
      );
    }
  });
  return favoriteIds.size;
}

function mapScopeId(
  scopeType: 'global' | 'topic' | 'project',
  scopeId: string,
  projects: Map<string, {
    originalProjectId: string;
    originalTopicId: string | null;
    mapping: PortableImportMapping;
  }>,
  topicIds: Map<string, string>,
) {
  if (scopeType === 'global') return 'global';
  if (scopeType === 'topic') return topicIds.get(scopeId) ?? null;
  return projects.get(scopeId)?.mapping.projectId ?? null;
}

async function cleanupFailedImport(db: SQLiteDatabase, projectIds: string[]) {
  if (!projectIds.length) return;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    for (const projectId of projectIds) {
      // Delete only IDs allocated by this import, in RESTRICT-safe dependency order.
      await transaction.runAsync('DELETE FROM conversation_documents WHERE document_id IN (SELECT id FROM documents WHERE project_id=?)', projectId);
      await transaction.runAsync('DELETE FROM favorites WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM graph_mutation_batches WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM source_items WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM edges WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM nodes WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM documents WHERE project_id = ?', projectId);
      await transaction.runAsync('DELETE FROM projects WHERE id = ?', projectId);
    }
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式错误`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}格式错误或超过 ${max} 项`);
  return value;
}

function stringValue(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value;
}

function nullableStringValue(value: unknown, label: string, max: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}无效`);
  return value;
}

function bodyValue(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000) throw new Error(`${label}为空或超过 1 MB`);
  return value;
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}无效`);
  return value;
}

function integerValue(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label}无效`);
  return value as T[number];
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
