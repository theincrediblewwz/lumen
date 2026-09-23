import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  deleteKnowledgeNode,
  getLatestAppliedGraphMutationBatch,
  getNodeDeleteImpact,
  undoGraphMutationBatch,
} from '../data/knowledge-repository';

test('node deletion rejects the root and a node with an active expansion job', async () => {
  const { native, adapter } = createGraphDatabase();

  await assert.rejects(() => deleteKnowledgeNode(adapter as never, 'root'), /根目标不能/);
  native.prepare(`INSERT INTO ai_expansion_jobs
    (id, project_id, selection_id, status) VALUES (?, ?, ?, ?)`)
    .run('job-active', 'p1', 'child', 'running');
  await assert.rejects(() => deleteKnowledgeNode(adapter as never, 'child'), /仍有 AI 任务/);

  assert.equal(readCount(native, 'nodes'), 3);
  native.close();
});

test('node deletion reports impact and removes only the selected node owned records', async () => {
  const { native, adapter } = createGraphDatabase();
  native.exec(`
    INSERT INTO node_answers VALUES ('a1', 'p1', 'child', NULL, 0);
    INSERT INTO node_answers VALUES ('a2', 'p1', 'child', NULL, 0);
    INSERT INTO ai_expansion_jobs VALUES ('job-old', 'p1', 'child', 'succeeded');
  `);

  const impact = await getNodeDeleteImpact(adapter as never, 'child');
  assert.deepEqual(impact, {
    nodeId: 'child', title: '子节点', isRoot: false,
    edgeCount: 2, answerCount: 2, favoriteCount: 0, activeJobCount: 0,
  });

  const deleted = await deleteKnowledgeNode(adapter as never, 'child');
  assert.equal(deleted.nodeId, 'child');
  assert.deepEqual(native.prepare('SELECT id FROM nodes ORDER BY id').all().map((row) => row.id), ['other', 'root']);
  assert.deepEqual(native.prepare('SELECT id FROM documents ORDER BY id').all().map((row) => row.id), ['doc-root', 'doc-shared']);
  assert.equal(readCount(native, 'edges'), 0);
  assert.equal(readCount(native, 'node_answers'), 0);
  assert.equal(readCount(native, 'ai_expansion_jobs'), 0);
  assert.deepEqual(native.prepare('PRAGMA foreign_key_check').all(), []);
  native.close();
});

test('node deletion is blocked while a favorite still points at the node', async () => {
  const { native, adapter } = createGraphDatabase();
  native.exec(`
    INSERT INTO favorites VALUES ('favorite-child', 'node', 'child', 'p1', 'child');
  `);

  const impact = await getNodeDeleteImpact(adapter as never, 'child');
  assert.equal(impact.favoriteCount, 1);
  await assert.rejects(() => deleteKnowledgeNode(adapter as never, 'child'), /请先在收藏中心取消收藏/);
  assert.equal(readCount(native, 'nodes'), 3);
  assert.equal(readCount(native, 'favorites'), 1);
  native.close();
});

test('node deletion rolls back the node, edges, answers and jobs when a later document cleanup fails', async () => {
  const { native, adapter } = createGraphDatabase();
  native.exec(`
    INSERT INTO node_answers VALUES ('a1', 'p1', 'child', NULL, 1);
    INSERT INTO ai_expansion_jobs VALUES ('job-old', 'p1', 'child', 'failed');
    CREATE TRIGGER fail_document_cleanup BEFORE DELETE ON documents
    BEGIN SELECT RAISE(ABORT, 'forced cleanup failure'); END;
  `);

  await assert.rejects(() => deleteKnowledgeNode(adapter as never, 'child'), /forced cleanup failure/);
  assert.equal(readCount(native, 'nodes'), 3);
  assert.equal(readCount(native, 'edges'), 2);
  assert.equal(readCount(native, 'node_answers'), 1);
  assert.equal(readCount(native, 'ai_expansion_jobs'), 1);
  assert.deepEqual(native.prepare('PRAGMA foreign_key_check').all(), []);
  native.close();
});

test('latest AI graph batch can be safely undone while its complete answer remains', async () => {
  const { native, adapter } = createUndoDatabase();
  const latest = await getLatestAppliedGraphMutationBatch(adapter as never, 'p1');
  assert.equal(latest?.id, 'batch-1');
  assert.deepEqual(latest?.createdNodeIds, ['child']);

  await undoGraphMutationBatch(adapter as never, 'batch-1');
  assert.equal(readCount(native, 'nodes'), 1);
  assert.equal(readCount(native, 'edges'), 0);
  assert.equal(readCount(native, 'node_answers'), 1);
  assert.equal(
    (native.prepare('SELECT status FROM graph_mutation_batches WHERE id = ?').get('batch-1') as { status: string }).status,
    'undone',
  );
  assert.equal(await getLatestAppliedGraphMutationBatch(adapter as never, 'p1'), null);
  native.close();
});

test('AI graph undo refuses edited or referenced generated content and rolls back no partial deletion', async () => {
  const edited = createUndoDatabase();
  edited.native.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('学习者改过的标题', 'child');
  await assert.rejects(() => undoGraphMutationBatch(edited.adapter as never, 'batch-1'), /后来已被修改/);
  assert.equal(readCount(edited.native, 'nodes'), 2);
  assert.equal(readCount(edited.native, 'edges'), 1);
  edited.native.close();

  const favorite = createUndoDatabase();
  favorite.native.exec(`INSERT INTO favorites VALUES ('favorite-child', 'node', 'child', 'p1', 'child')`);
  await assert.rejects(() => undoGraphMutationBatch(favorite.adapter as never, 'batch-1'), /收藏引用/);
  assert.equal(readCount(favorite.native, 'nodes'), 2);
  assert.equal(readCount(favorite.native, 'edges'), 1);
  favorite.native.close();
});

function createGraphDatabase() {
  const native = new DatabaseSync(':memory:');
  native.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      layout_direction TEXT NOT NULL DEFAULT 'vertical'
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL,
      y REAL NOT NULL,
      importance INTEGER NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      importance INTEGER NOT NULL,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
      review_status TEXT NOT NULL DEFAULT 'unverified',
      reviewed_at TEXT
    );
    CREATE TABLE ai_expansion_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selection_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE node_answers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES ai_expansion_jobs(id) ON DELETE SET NULL,
      is_saved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE favorites (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
    );
    INSERT INTO projects VALUES ('p1', 'now', 'vertical');
    INSERT INTO documents VALUES ('doc-root', 'p1'), ('doc-child', 'p1'),
      ('doc-edge-1', 'p1'), ('doc-edge-2', 'p1'), ('doc-shared', 'p1');
    INSERT INTO nodes VALUES
      ('root', 'p1', '根目标', '', 0, 0, 10, 'essential', 0, 'doc-root'),
      ('child', 'p1', '子节点', '', 0, 0, 8, 'learning', 1, 'doc-child'),
      ('other', 'p1', '保留节点', '', 0, 0, 7, 'learning', 2, 'doc-shared');
    INSERT INTO edges VALUES
      ('e1', 'p1', 'root', 'child', 'prerequisite', 8, 'doc-edge-1', 'unverified', NULL),
      ('e2', 'p1', 'child', 'other', 'support', 7, 'doc-edge-2', 'unverified', NULL);
  `);

  const adapter = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = native.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstAsync: async <T>(sql: string, ...params: unknown[]) => (native.prepare(sql).get(...params as never[]) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: unknown[]) => native.prepare(sql).all(...params as never[]) as T[],
    withExclusiveTransactionAsync: async (task: (value: unknown) => Promise<void>) => {
      native.exec('BEGIN EXCLUSIVE');
      try {
        await task(adapter);
        native.exec('COMMIT');
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { native, adapter };
}

function createUndoDatabase() {
  const native = new DatabaseSync(':memory:');
  native.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, updated_at TEXT NOT NULL,
      layout_direction TEXT NOT NULL DEFAULT 'vertical'
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, subtitle TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      importance INTEGER NOT NULL, status TEXT NOT NULL, sort_order INTEGER,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL, effective_relation TEXT, importance INTEGER NOT NULL,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
      review_status TEXT NOT NULL, reviewed_at TEXT
    );
    CREATE TABLE ai_expansion_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selection_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE node_answers (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE favorites (
      id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE mastery_attempts (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE source_items (
      id TEXT PRIMARY KEY, derived_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
    );
    CREATE TABLE graph_mutation_batches (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selection_id TEXT NOT NULL, job_id TEXT NOT NULL, answer_id TEXT NOT NULL,
      status TEXT NOT NULL, created_node_ids_json TEXT NOT NULL,
      created_edge_ids_json TEXT NOT NULL, created_document_ids_json TEXT NOT NULL,
      object_fingerprints_json TEXT NOT NULL, committed_at TEXT NOT NULL, undone_at TEXT
    );
    INSERT INTO projects VALUES ('p1', 'now', 'vertical');
    INSERT INTO documents VALUES
      ('doc-root', 'p1', '根目标', '# 根目标'),
      ('doc-child', 'p1', '新节点', '# 新节点'),
      ('doc-edge', 'p1', '生成关系', '# 生成关系');
    INSERT INTO nodes VALUES
      ('root', 'p1', '根目标', '', 0, 0, 10, 'essential', 0, 'doc-root'),
      ('child', 'p1', '新节点', '说明', 0, 200, 8, 'learning', 1, 'doc-child');
    INSERT INTO edges VALUES
      ('edge-1', 'p1', 'root', 'child', 'prerequisite', NULL, 8, 'doc-edge', 'unverified', NULL);
    INSERT INTO ai_expansion_jobs VALUES ('job-1', 'p1', 'root', 'succeeded');
    INSERT INTO node_answers VALUES ('answer-1', 'p1', 'root');
  `);
  const fingerprints = {
    version: 1,
    nodes: [{
      id: 'child', title: '新节点', subtitle: '说明', importance: 8, status: 'learning',
      documentId: 'doc-child', documentTitle: '新节点', documentBody: '# 新节点',
    }],
    edges: [{
      id: 'edge-1', sourceId: 'root', targetId: 'child', relation: 'prerequisite',
      importance: 8, reviewStatus: 'unverified', documentId: 'doc-edge',
      documentTitle: '生成关系', documentBody: '# 生成关系',
    }],
  };
  native.prepare(`
    INSERT INTO graph_mutation_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'batch-1', 'p1', 'root', 'job-1', 'answer-1', 'applied',
    JSON.stringify(['child']), JSON.stringify(['edge-1']),
    JSON.stringify(['doc-child', 'doc-edge']), JSON.stringify(fingerprints),
    '2026-07-29T00:00:00.000Z', null,
  );
  return { native, adapter: createAdapter(native) };
}

function createAdapter(native: DatabaseSync) {
  const adapter = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = native.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstAsync: async <T>(sql: string, ...params: unknown[]) => (native.prepare(sql).get(...params as never[]) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: unknown[]) => native.prepare(sql).all(...params as never[]) as T[],
    withExclusiveTransactionAsync: async (task: (value: unknown) => Promise<void>) => {
      native.exec('BEGIN EXCLUSIVE');
      try {
        await task(adapter);
        native.exec('COMMIT');
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter;
}

function readCount(db: DatabaseSync, table: string) {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
