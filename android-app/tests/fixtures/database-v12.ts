// Frozen historical migration fixture; do not update to match the current schema.
// Source: commit 2f52fbc8a58c7bd89e09cbdc8aad49b16fa7b3cf, android-app/data/database.ts
// Git blob: b2262f44db1713d540558f47104ddf2df34cd60a
// Historical CURRENT_DATABASE_VERSION=11 is intentionally preserved: actual user_version reaches 12.
// Only this provenance header was added; runtime uses the original historical migration unchanged.
import type { SQLiteDatabase } from 'expo-sqlite';

const INITIAL_PROJECT_ID = 'project-transformer';
export const CURRENT_DATABASE_VERSION = 11;

const BACKUP_CONTENT_TABLES = ['projects', 'documents', 'nodes', 'edges', 'node_answers', 'prompt_templates'] as const;
const BACKUP_CONTENT_ACTIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;

const backupTriggers = BACKUP_CONTENT_TABLES.flatMap((table) => BACKUP_CONTENT_ACTIONS.map((action) => `
  CREATE TRIGGER backup_${table}_${action.toLowerCase()}
  AFTER ${action} ON ${table}
  BEGIN
    UPDATE local_backup_jobs
    SET revision = revision + 1,
        status = CASE
          WHEN (SELECT enabled FROM local_backup_settings WHERE id = 1) = 0 THEN 'idle'
          WHEN status = 'running' THEN 'running'
          ELSE 'pending'
        END,
        requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        last_error = CASE WHEN status = 'running' THEN last_error ELSE NULL END
    WHERE id = 1;
  END;
`)).join('\n');

export const LOCAL_BACKUP_MIGRATION_SQL = `
  CREATE TABLE local_backup_settings (
    id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
    directory_uri TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    active_slot TEXT CHECK(active_slot IN ('a', 'b')),
    updated_at TEXT NOT NULL
  );
  INSERT INTO local_backup_settings (id, directory_uri, enabled, active_slot, updated_at)
  VALUES (1, NULL, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  CREATE TABLE local_backup_jobs (
    id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
    status TEXT NOT NULL CHECK(status IN ('idle', 'pending', 'running', 'failed', 'synced')),
    revision INTEGER NOT NULL DEFAULT 0,
    synced_revision INTEGER NOT NULL DEFAULT 0,
    target_revision INTEGER,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 5,
    progress_label TEXT,
    requested_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    last_error TEXT
  );
  INSERT INTO local_backup_jobs
    (id, status, revision, synced_revision, target_revision, progress_current, progress_total)
  VALUES (1, 'idle', 0, 0, NULL, 0, 5);

  ${backupTriggers}
  PRAGMA user_version = 8;
`;

export const LOCAL_BACKUP_RECOVERY_SQL = `
  UPDATE local_backup_jobs
  SET status = CASE
        WHEN (SELECT enabled FROM local_backup_settings WHERE id = 1) = 1 THEN 'pending'
        ELSE 'idle'
      END,
      target_revision = NULL,
      progress_current = 0,
      progress_label = NULL,
      last_error = '上次本地备份被中断，已等待应用恢复后继续'
  WHERE status = 'running';
`;

export const LAYOUT_DIRECTION_MIGRATION_SQL = `
  ALTER TABLE projects ADD COLUMN layout_direction TEXT NOT NULL DEFAULT 'vertical'
    CHECK(layout_direction IN ('vertical', 'horizontal'));
  PRAGMA user_version = 9;
`;

export const DEEP_BUILD_MIGRATION_SQL = `
  ALTER TABLE ai_expansion_jobs ADD COLUMN quality_path TEXT NOT NULL DEFAULT 'quick'
    CHECK(quality_path IN ('quick', 'deep'));
  CREATE TABLE ai_deep_build_stages (
    job_id TEXT NOT NULL REFERENCES ai_expansion_jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL
      CHECK(stage IN ('knowledge_dossier', 'teaching_plan', 'graph_compilation')),
    stage_order INTEGER NOT NULL CHECK(stage_order BETWEEN 1 AND 3),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'unknown_charge')),
    request_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    artifact_json TEXT,
    artifact_fingerprint TEXT,
    usage_json TEXT,
    actual_model TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(job_id, stage)
  );
  CREATE INDEX idx_deep_build_stage_status
    ON ai_deep_build_stages(status, updated_at);
  PRAGMA user_version = 10;
`;

const PERSONAL_CONTEXT_BACKUP_TABLES = [
  'topics',
  'ai_understanding_documents',
  'project_ai_scope_settings',
  'favorites',
  'favorite_bindings',
] as const;

const personalContextBackupTriggers = PERSONAL_CONTEXT_BACKUP_TABLES.flatMap((table) => (
  BACKUP_CONTENT_ACTIONS.map((action) => `
    CREATE TRIGGER backup_${table}_${action.toLowerCase()}
    AFTER ${action} ON ${table}
    BEGIN
      UPDATE local_backup_jobs
      SET revision = revision + 1,
          status = CASE
            WHEN (SELECT enabled FROM local_backup_settings WHERE id = 1) = 0 THEN 'idle'
            WHEN status = 'running' THEN 'running'
            ELSE 'pending'
          END,
          requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = CASE WHEN status = 'running' THEN last_error ELSE NULL END
      WHERE id = 1;
    END;
  `)
)).join('\n');

const CONTENT_V2_BACKUP_TABLES = [
  'source_items',
  'source_segments',
  'source_citations',
  'mastery_attempts',
  'graph_mutation_batches',
] as const;

const contentV2BackupTriggers = CONTENT_V2_BACKUP_TABLES.flatMap((table) => (
  BACKUP_CONTENT_ACTIONS.map((action) => `
    CREATE TRIGGER backup_${table}_${action.toLowerCase()}
    AFTER ${action} ON ${table}
    BEGIN
      UPDATE local_backup_jobs
      SET revision = revision + 1,
          status = CASE
            WHEN (SELECT enabled FROM local_backup_settings WHERE id = 1) = 0 THEN 'idle'
            WHEN status = 'running' THEN 'running'
            ELSE 'pending'
          END,
          requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = CASE WHEN status = 'running' THEN last_error ELSE NULL END
      WHERE id = 1;
    END;
  `)
)).join('\n');

export const PERSONAL_CONTEXT_MIGRATION_SQL = `
  ALTER TABLE ai_expansion_jobs ADD COLUMN context_plan_json TEXT;

  CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES topics(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(parent_id IS NULL OR parent_id != id)
  );
  CREATE INDEX idx_topics_parent ON topics(parent_id, updated_at DESC);

  ALTER TABLE projects ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL;
  CREATE INDEX idx_projects_topic ON projects(topic_id, updated_at DESC);

  CREATE TABLE ai_understanding_documents (
    id TEXT PRIMARY KEY NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'topic', 'project')),
    scope_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('preference', 'known', 'pending')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scope_type, scope_id, category, title)
  );
  CREATE INDEX idx_understanding_scope
    ON ai_understanding_documents(scope_type, scope_id, enabled, updated_at DESC);

  CREATE TABLE project_ai_scope_settings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'topic', 'project')),
    scope_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, scope_type, scope_id)
  );

  CREATE TABLE favorites (
    id TEXT PRIMARY KEY NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('node', 'answer')),
    target_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(target_type, target_id)
  );
  CREATE INDEX idx_favorites_project ON favorites(project_id, created_at DESC);
  CREATE INDEX idx_favorites_node ON favorites(node_id, created_at DESC);

  CREATE TABLE favorite_bindings (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'topic', 'project')),
    scope_id TEXT NOT NULL,
    favorite_id TEXT NOT NULL REFERENCES favorites(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope_type, scope_id, favorite_id)
  );
  CREATE INDEX idx_favorite_bindings_favorite ON favorite_bindings(favorite_id);

  INSERT OR IGNORE INTO favorites
    (id, target_type, target_id, project_id, node_id, created_at)
  SELECT 'favorite-answer-' || id, 'answer', id, project_id, node_id, created_at
  FROM node_answers
  WHERE is_saved = 1;

  CREATE TRIGGER sync_saved_answer_insert
  AFTER INSERT ON node_answers
  WHEN NEW.is_saved = 1
  BEGIN
    INSERT OR IGNORE INTO favorites
      (id, target_type, target_id, project_id, node_id, created_at)
    VALUES (
      'favorite-answer-' || NEW.id,
      'answer',
      NEW.id,
      NEW.project_id,
      NEW.node_id,
      NEW.created_at
    );
  END;

  CREATE TRIGGER sync_saved_answer_update_on
  AFTER UPDATE OF is_saved ON node_answers
  WHEN NEW.is_saved = 1
  BEGIN
    INSERT OR IGNORE INTO favorites
      (id, target_type, target_id, project_id, node_id, created_at)
    VALUES (
      'favorite-answer-' || NEW.id,
      'answer',
      NEW.id,
      NEW.project_id,
      NEW.node_id,
      NEW.updated_at
    );
  END;

  CREATE TRIGGER sync_saved_answer_update_off
  AFTER UPDATE OF is_saved ON node_answers
  WHEN NEW.is_saved = 0
  BEGIN
    DELETE FROM favorites WHERE target_type = 'answer' AND target_id = NEW.id;
  END;

  CREATE TRIGGER sync_favorite_answer_insert
  AFTER INSERT ON favorites
  WHEN NEW.target_type = 'answer'
  BEGIN
    UPDATE node_answers SET is_saved = 1, updated_at = NEW.created_at WHERE id = NEW.target_id;
  END;

  CREATE TRIGGER sync_favorite_answer_delete
  AFTER DELETE ON favorites
  WHEN OLD.target_type = 'answer'
  BEGIN
    UPDATE node_answers
    SET is_saved = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.target_id;
  END;

  CREATE VIRTUAL TABLE context_search_fts USING fts5(
    kind UNINDEXED,
    source_id UNINDEXED,
    project_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  );

  ${personalContextBackupTriggers}
  PRAGMA user_version = 11;
`;

export const CONTENT_V2_MIGRATION_SQL = `
  ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'learning'
    CHECK(mode IN ('learning', 'summary'));
  ALTER TABLE projects ADD COLUMN explanation_style TEXT NOT NULL DEFAULT 'legacy'
    CHECK(explanation_style IN ('legacy', 'plain_language'));
  ALTER TABLE projects ADD COLUMN detail_level TEXT NOT NULL DEFAULT 'detailed'
    CHECK(detail_level IN ('one_sentence', 'concise', 'detailed', 'deep'));
  ALTER TABLE projects ADD COLUMN allow_outside_knowledge INTEGER NOT NULL DEFAULT 1
    CHECK(allow_outside_knowledge IN (0, 1));
  ALTER TABLE edges ADD COLUMN effective_relation TEXT
    CHECK(effective_relation IS NULL OR effective_relation IN (
      'prerequisite', 'evidence', 'analogy', 'support', 'counterexample', 'contains'
    ));

  CREATE TABLE source_items (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('text', 'markdown', 'pdf', 'image', 'web')),
    title TEXT NOT NULL,
    original_name TEXT,
    media_type TEXT NOT NULL,
    asset_uri TEXT,
    source_url TEXT,
    content_hash TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
    extraction_status TEXT NOT NULL CHECK(extraction_status IN ('ready', 'processing', 'failed')),
    extraction_error TEXT,
    derived_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, content_hash, kind)
  );
  CREATE INDEX idx_source_items_project ON source_items(project_id, created_at, id);

  CREATE TABLE source_segments (
    id TEXT PRIMARY KEY NOT NULL,
    source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    locator_type TEXT NOT NULL CHECK(locator_type IN ('text', 'paragraph', 'page', 'image', 'url')),
    locator TEXT NOT NULL,
    body TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(source_item_id, ordinal)
  );
  CREATE INDEX idx_source_segments_item ON source_segments(source_item_id, ordinal);

  CREATE TABLE source_citations (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('node', 'edge', 'answer', 'document')),
    target_id TEXT NOT NULL,
    source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
    locator TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(target_type, target_id, source_item_id, locator)
  );
  CREATE INDEX idx_source_citations_target ON source_citations(target_type, target_id);

  CREATE TABLE mastery_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    learner_answer TEXT NOT NULL,
    reference_points TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('passed', 'continue_learning')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mastery_attempts_node ON mastery_attempts(node_id, created_at DESC);

  CREATE TABLE graph_mutation_batches (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    selection_id TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    answer_id TEXT NOT NULL REFERENCES node_answers(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied', 'undone')),
    created_node_ids_json TEXT NOT NULL,
    created_edge_ids_json TEXT NOT NULL,
    created_document_ids_json TEXT NOT NULL,
    object_fingerprints_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE INDEX idx_graph_batches_project ON graph_mutation_batches(project_id, committed_at DESC);

  ${contentV2BackupTriggers}
  PRAGMA user_version = 12;
`;

export const LOCAL_KNOWLEDGE_MIGRATION_SQL = `
  CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_prompt_templates_order ON prompt_templates(sort_order, updated_at DESC);
  CREATE TABLE node_answers (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES ai_expansion_jobs(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    body TEXT NOT NULL,
    adapter TEXT NOT NULL CHECK(adapter IN ('local', 'gateway', 'byok', 'imported')),
    actual_model TEXT,
    is_saved INTEGER NOT NULL DEFAULT 0 CHECK(is_saved IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_node_answers_node ON node_answers(node_id, is_saved DESC, created_at DESC);
  CREATE INDEX idx_node_answers_project ON node_answers(project_id, is_saved DESC, created_at DESC);
  PRAGMA user_version = 7;
`;

export const EDGE_REVIEW_MIGRATION_SQL = `
  ALTER TABLE edges ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK(review_status IN ('unverified', 'learner_supported', 'disputed'));
  ALTER TABLE edges ADD COLUMN reviewed_at TEXT;
  PRAGMA user_version = 5;
`;

export const BYOK_JOB_MIGRATION_SQL = `
  DROP INDEX IF EXISTS idx_ai_jobs_project;
  DROP INDEX IF EXISTS idx_ai_jobs_recovery;
  DROP INDEX IF EXISTS idx_ai_jobs_active_selection;
  ALTER TABLE ai_expansion_jobs RENAME TO ai_expansion_jobs_v5;
  CREATE TABLE ai_expansion_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    selection_type TEXT NOT NULL CHECK(selection_type IN ('node')),
    selection_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    adapter TEXT NOT NULL CHECK(adapter IN ('local', 'gateway', 'byok')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    request_json TEXT NOT NULL,
    response_json TEXT,
    error_code TEXT,
    error_message TEXT,
    next_retry_at TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO ai_expansion_jobs
    (id, project_id, selection_type, selection_id, prompt, adapter, status, attempt_count,
     request_json, response_json, error_code, error_message, next_retry_at, lease_expires_at,
     created_at, updated_at)
  SELECT id, project_id, selection_type, selection_id, prompt, adapter, status, attempt_count,
     request_json, response_json, error_code, error_message, next_retry_at, lease_expires_at,
     created_at, updated_at
  FROM ai_expansion_jobs_v5;
  DROP TABLE ai_expansion_jobs_v5;
  CREATE INDEX idx_ai_jobs_project ON ai_expansion_jobs(project_id, created_at DESC);
  CREATE INDEX idx_ai_jobs_recovery ON ai_expansion_jobs(status, lease_expires_at, next_retry_at);
  CREATE UNIQUE INDEX idx_ai_jobs_active_selection
    ON ai_expansion_jobs(project_id, selection_id)
    WHERE status IN ('queued', 'running', 'retry_wait');
  PRAGMA user_version = 6;
`;

export async function migrateDatabase(db: SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = versionRow?.user_version ?? 0;

  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        source_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('source', 'ai', 'learner')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        x REAL NOT NULL,
        y REAL NOT NULL,
        importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10),
        status TEXT NOT NULL CHECK(status IN ('essential', 'learning', 'mastered', 'uncertain', 'optional')),
        sort_order INTEGER,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK(relation IN ('prerequisite', 'evidence', 'analogy', 'support', 'counterexample')),
        importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10),
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        UNIQUE(project_id, source_id, target_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
      CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);
      PRAGMA user_version = 1;
    `);
  }

  if (version < 2) {
    await db.execAsync(`
      UPDATE documents
      SET title = (
        SELECT source.title || ' → ' || target.title
        FROM edges
        JOIN nodes AS source ON source.id = edges.source_id
        JOIN nodes AS target ON target.id = edges.target_id
        WHERE edges.document_id = documents.id
      )
      WHERE id IN (SELECT document_id FROM edges);
      PRAGMA user_version = 2;
    `);
  }

  if (version < 3) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ai_expansion_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        selection_type TEXT NOT NULL CHECK(selection_type IN ('node')),
        selection_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        adapter TEXT NOT NULL CHECK(adapter IN ('local', 'gateway')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_code TEXT,
        error_message TEXT,
        next_retry_at TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_project ON ai_expansion_jobs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_recovery ON ai_expansion_jobs(status, lease_expires_at, next_retry_at);
      PRAGMA user_version = 3;
    `);
  }

  if (version < 4) {
    await db.execAsync(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_jobs_active_selection
      ON ai_expansion_jobs(project_id, selection_id)
      WHERE status IN ('queued', 'running', 'retry_wait');
      PRAGMA user_version = 4;
    `);
  }

  if (version < 5) {
    await db.execAsync(EDGE_REVIEW_MIGRATION_SQL);
  }

  if (version < 6) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(BYOK_JOB_MIGRATION_SQL);
    });
  }

  if (version < 7) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(LOCAL_KNOWLEDGE_MIGRATION_SQL);
    });
  }

  if (version < 8) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(LOCAL_BACKUP_MIGRATION_SQL);
    });
  }

  if (version < 9) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(LAYOUT_DIRECTION_MIGRATION_SQL);
    });
  }

  if (version < 10) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(DEEP_BUILD_MIGRATION_SQL);
    });
  }

  if (version < 11) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(PERSONAL_CONTEXT_MIGRATION_SQL);
    });
  }

  if (version < 12) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(CONTENT_V2_MIGRATION_SQL);
    });
  }

  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'failed', lease_expires_at = NULL, next_retry_at = NULL,
         error_code = 'provider_outcome_unknown',
         error_message = '上次个人 AI 请求被中断，是否已计费不确定；不会自动重试', updated_at = ?
     WHERE adapter = 'byok' AND status = 'running'`,
    now,
  );
  await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'queued', lease_expires_at = NULL, error_code = 'worker_interrupted',
         error_message = '上次展开被中断，已排队等待恢复', updated_at = ?
     WHERE adapter != 'byok' AND status = 'running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    now,
    now,
  );
  await db.runAsync(
    `UPDATE ai_expansion_jobs
     SET status = 'queued', next_retry_at = NULL, updated_at = ?
     WHERE status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`,
    now,
    now,
  );
  await db.runAsync(
    `UPDATE ai_deep_build_stages
     SET status = 'unknown_charge', completed_at = ?, updated_at = ?,
         error_code = 'provider_outcome_unknown',
         error_message = '上次深入构建请求被中断，是否已计费不确定；不会自动重试'
     WHERE status = 'running'`,
    now,
    now,
  );
  await db.execAsync(LOCAL_BACKUP_RECOVERY_SQL);

  await seedInitialProject(db);
}

async function seedInitialProject(db: SQLiteDatabase) {
  const existing = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM projects');
  if ((existing?.count ?? 0) > 0) return;

  const now = new Date().toISOString();
  const documents = [
    ['doc-transformer', '目标/理解-transformer.md', '理解 Transformer', '# 理解 Transformer\n\n目标不是记住结构图，而是能够解释信息如何从输入流向输出，并判断每个组件解决了什么问题。'],
    ['doc-attention', '前置/注意力机制.md', '注意力机制', '# 注意力机制\n\n注意力让每个位置根据相关性，从其他位置选择并聚合信息。'],
    ['doc-qkv', '前置/qkv-表示.md', 'Q / K / V 表示', '# Q / K / V\n\n- Query 表示当前要寻找什么\n- Key 表示每个位置能被怎样匹配\n- Value 表示真正被聚合的信息'],
    ['doc-scaled', '前置/缩放点积注意力.md', '缩放点积注意力', '# 缩放点积注意力\n\n缩放项用于控制高维点积的数值幅度，避免 softmax 过早饱和。'],
    ['doc-softmax', '基础/softmax.md', 'Softmax', '# Softmax\n\n把一组分数转换为总和为 1 的权重，用于表达相对关注程度。'],
    ['doc-linear', '基础/线性代数.md', '向量与矩阵', '# 向量与矩阵\n\n这是当前学习路径已经掌握的锚点。矩阵乘法可理解为批量线性变换。'],
  ] as const;

  const nodes = [
    ['node-transformer', '理解 Transformer', '目标知识', 516, 100, 10, 'essential', 0, 'doc-transformer'],
    ['node-attention', '注意力机制', '信息选择与聚合', 260, 340, 9, 'essential', 1, 'doc-attention'],
    ['node-qkv', 'Q / K / V', '匹配与内容表示', 620, 390, 8, 'learning', 2, 'doc-qkv'],
    ['node-scaled', '缩放点积注意力', '稳定相关性分数', 420, 650, 8, 'learning', 3, 'doc-scaled'],
    ['node-softmax', 'Softmax', '分数转为权重', 760, 730, 7, 'uncertain', 4, 'doc-softmax'],
    ['node-linear', '向量与矩阵', '已经掌握的基础', 250, 940, 6, 'mastered', 5, 'doc-linear'],
  ] as const;

  const edges = [
    ['edge-root-attention', 'node-transformer', 'node-attention', 'prerequisite', 10],
    ['edge-root-qkv', 'node-transformer', 'node-qkv', 'prerequisite', 9],
    ['edge-attention-scaled', 'node-attention', 'node-scaled', 'prerequisite', 9],
    ['edge-qkv-scaled', 'node-qkv', 'node-scaled', 'support', 8],
    ['edge-scaled-softmax', 'node-scaled', 'node-softmax', 'prerequisite', 8],
    ['edge-scaled-linear', 'node-scaled', 'node-linear', 'prerequisite', 7],
  ] as const;
  const nodeTitleById = new Map(nodes.map(([id, title]) => [id, title]));

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, title, source_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      INITIAL_PROJECT_ID,
      '理解 Transformer',
      '从整体结构出发，追溯到已经掌握的数学基础。',
      now,
      now,
    );

    for (const [id, path, title, body] of documents) {
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        INITIAL_PROJECT_ID,
        path,
        title,
        body,
        id === 'doc-transformer' ? 'source' : 'ai',
        now,
        now,
      );
    }

    for (const [id, title, subtitle, x, y, importance, status, order, documentId] of nodes) {
      await transaction.runAsync(
        'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        INITIAL_PROJECT_ID,
        title,
        subtitle,
        x,
        y,
        importance,
        status,
        order,
        documentId,
      );
    }

    for (const [id, sourceId, targetId, relation, importance] of edges) {
      const documentId = `doc-${id}`;
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        documentId,
        INITIAL_PROJECT_ID,
        `关系/${id}.md`,
        `${nodeTitleById.get(sourceId)} → ${nodeTitleById.get(targetId)}`,
        `# 关系说明\n\n**类型：** ${relation}\n\n这条关系说明目标概念为什么需要连接到下一知识点。`,
        'ai',
        now,
        now,
      );
      await transaction.runAsync(
        'INSERT INTO edges (id, project_id, source_id, target_id, relation, importance, document_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        INITIAL_PROJECT_ID,
        sourceId,
        targetId,
        relation,
        importance,
        documentId,
      );
    }
  });
}
