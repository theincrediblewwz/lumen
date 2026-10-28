import { KNOWLEDGE_SYNC_TRIGGERS_SQL } from './sync-schema';

const backupTriggers = ['knowledge_entries', 'knowledge_revisions', 'knowledge_bindings', 'knowledge_reference_settings'].flatMap(table =>
  ['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER backup_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
    UPDATE local_backup_jobs SET revision=revision+1,
      status=CASE WHEN (SELECT enabled FROM local_backup_settings WHERE id=1)=0 THEN 'idle' WHEN status='running' THEN 'running' ELSE 'pending' END,
      requested_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1; END;`)).join('\n');

/** Additive v19: entries and history have no project-owned lifetime. */
export const KNOWLEDGE_LIBRARY_MIGRATION_SQL = `
CREATE TABLE knowledge_entries (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('understanding','experience','material')),
 title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
 authorship TEXT NOT NULL CHECK(authorship IN ('user','ai_adopted','source')), basis_json TEXT NOT NULL DEFAULT '[]',
 revision_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_entries_recent ON knowledge_entries(archived,updated_at DESC);
CREATE TABLE knowledge_revisions (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('understanding','experience','material')), title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL,
 authorship TEXT NOT NULL CHECK(authorship IN ('user','ai_adopted','source')), basis_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX knowledge_revisions_entry ON knowledge_revisions(entry_id,created_at);
CREATE TABLE knowledge_bindings (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE, entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX knowledge_binding_identity ON knowledge_bindings(project_id,COALESCE(node_id,''),entry_id);
CREATE TABLE knowledge_reference_settings (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
 policy TEXT NOT NULL CHECK(policy IN('disabled','allowed','priority')), updated_at TEXT NOT NULL
);
${KNOWLEDGE_SYNC_TRIGGERS_SQL}
${backupTriggers}
PRAGMA user_version=19;
`;
