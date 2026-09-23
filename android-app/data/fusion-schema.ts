// Additive migration: the original node document remains the primary document.
const tables = ['conversations', 'conversation_messages', 'conversation_documents', 'node_documents', 'reading_positions'];
export const FUSION_MIGRATION_SQL = `
ALTER TABLE projects ADD COLUMN graph_kind TEXT NOT NULL DEFAULT 'learning' CHECK(graph_kind IN ('free','learning','summary'));
UPDATE projects SET graph_kind = mode;
ALTER TABLE edges ADD COLUMN relation_kind TEXT;
ALTER TABLE edges ADD COLUMN directed INTEGER NOT NULL DEFAULT 1 CHECK(directed IN (0,1));
ALTER TABLE edges ADD COLUMN label TEXT NOT NULL DEFAULT '';
CREATE TABLE node_documents (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0, UNIQUE(node_id, document_id)
);
INSERT INTO node_documents SELECT 'link-' || id || '-' || document_id, id, document_id, 0 FROM nodes;
CREATE TRIGGER node_primary_document_insert AFTER INSERT ON nodes BEGIN
  INSERT OR IGNORE INTO node_documents VALUES ('link-' || NEW.id || '-' || NEW.document_id, NEW.id, NEW.document_id, 0);
END;
CREATE TRIGGER node_primary_document_update AFTER UPDATE OF document_id ON nodes BEGIN
  INSERT OR IGNORE INTO node_documents VALUES ('link-' || NEW.id || '-' || NEW.document_id, NEW.id, NEW.document_id, 0);
END;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX conversations_project ON conversations(project_id, updated_at);
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','complete','interrupted','failed')),
  ordinal INTEGER NOT NULL, request_id TEXT, actual_model TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX conversation_message_order ON conversation_messages(conversation_id, ordinal, id);
CREATE UNIQUE INDEX conversation_pending ON conversation_messages(conversation_id) WHERE status = 'pending';
CREATE TABLE conversation_documents (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_answer_id TEXT REFERENCES node_answers(id) ON DELETE SET NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  message_ids_json TEXT NOT NULL DEFAULT '[]', selection_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE reading_positions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT NOT NULL DEFAULT '', ratio REAL NOT NULL DEFAULT 0 CHECK(ratio >= 0 AND ratio <= 1), updated_at TEXT NOT NULL
);
${tables.flatMap(table => ['INSERT','UPDATE','DELETE'].map(action => `
CREATE TRIGGER backup_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
 UPDATE local_backup_jobs SET revision=revision+1,
 status=CASE WHEN (SELECT enabled FROM local_backup_settings WHERE id=1)=0 THEN 'idle' WHEN status='running' THEN 'running' ELSE 'pending' END,
 requested_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
END;`)).join('\n')}
PRAGMA user_version = 13;
`;
