/** Content only: credentials and executable AI jobs never enter the sync log. */
export const SYNC_TABLES = [
  'topics', 'projects', 'documents', 'nodes', 'edges', 'node_answers', 'prompt_templates',
  'ai_understanding_documents', 'project_ai_scope_settings', 'favorites', 'favorite_bindings',
  'source_items', 'source_segments', 'source_citations', 'mastery_attempts', 'graph_mutation_batches',
  'conversations', 'conversation_messages', 'node_documents', 'conversation_documents', 'reading_positions',
] as const;

export type SyncTable = typeof SYNC_TABLES[number];

export const SYNC_PRIMARY_KEYS: Partial<Record<SyncTable, string[]>> = {
  project_ai_scope_settings: ['project_id', 'scope_type', 'scope_id'],
  favorite_bindings: ['scope_type', 'scope_id', 'favorite_id'],
};

export function syncIdSql(table: SyncTable, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const keys = SYNC_PRIMARY_KEYS[table];
  return keys ? `json_array(${keys.map((key) => prefix + key).join(',')})` : `${prefix}id`;
}

const triggers = SYNC_TABLES.flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((action) => {
  const row = action === 'DELETE' ? 'OLD' : 'NEW';
  return `CREATE TRIGGER sync_track_${table}_${action.toLowerCase()}
    AFTER ${action} ON ${table} WHEN (SELECT suppress FROM sync_control WHERE id=1)=0
    BEGIN
      UPDATE sync_control SET revision=revision+1 WHERE id=1;
      INSERT INTO sync_changes(kind,entity_id,revision) VALUES ('${table}',${syncIdSql(table, row)},(SELECT revision FROM sync_control WHERE id=1))
      ON CONFLICT(kind,entity_id) DO UPDATE SET revision=excluded.revision;
      ${action === 'UPDATE' ? `INSERT INTO sync_changes(kind,entity_id,revision)
        SELECT '${table}',${syncIdSql(table, 'OLD')},(SELECT revision FROM sync_control WHERE id=1) WHERE ${syncIdSql(table, 'OLD')}!=${syncIdSql(table, 'NEW')}
        ON CONFLICT(kind,entity_id) DO UPDATE SET revision=excluded.revision;` : ''}
    END;`;
})).join('\n');

/** Run after the fusion migration, in its own exclusive migration transaction. */
export const SYNC_MIGRATION_SQL = `
  CREATE TABLE sync_control(id INTEGER PRIMARY KEY CHECK(id=1), suppress INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_expires_at INTEGER);
  INSERT INTO sync_control(id) VALUES(1);
  CREATE TABLE sync_changes(kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(kind,entity_id));
  CREATE TABLE sync_state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
  CREATE TABLE sync_projection(kind TEXT NOT NULL,entity_id TEXT NOT NULL,board_id TEXT,body TEXT,PRIMARY KEY(kind,entity_id));
  CREATE TABLE sync_conflicts(id TEXT PRIMARY KEY,body TEXT NOT NULL,resolved_at TEXT);
  CREATE TABLE sync_blocked_inbound(id TEXT PRIMARY KEY,body TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);
  CREATE TABLE sync_settings(id INTEGER PRIMARY KEY CHECK(id=1),endpoint TEXT NOT NULL DEFAULT '',library_id TEXT NOT NULL DEFAULT 'my-learning',
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),consented_at TEXT,last_success_at TEXT,last_attempt_at TEXT,last_error TEXT,
    status TEXT NOT NULL DEFAULT 'paused',device_id TEXT NOT NULL DEFAULT '',background_error TEXT);
  INSERT INTO sync_settings(id) VALUES(1);
  ${triggers}
  ${SYNC_TABLES.map((table) => `INSERT INTO sync_changes(kind,entity_id,revision) SELECT '${table}',${syncIdSql(table)},0 FROM ${table};`).join('\n')}
`;
