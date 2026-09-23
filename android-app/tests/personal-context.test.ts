import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { PERSONAL_CONTEXT_MIGRATION_SQL } from '../data/database';
import {
  createTopic,
  listProjectUnderstandingScopes,
  loadPersonalContextEvidence,
  saveUnderstandingDocument,
  setFavoriteBinding,
  setProjectUnderstandingScopeEnabled,
} from '../data/personal-context';

test('v11 migration preserves saved answers as unified favorites and adds persisted context plans', () => {
  const { native } = createPersonalContextDatabase();
  const favorite = native.prepare(
    `SELECT target_type, target_id, project_id, node_id FROM favorites WHERE target_id = 'answer-1'`,
  ).get() as Record<string, string>;
  assert.deepEqual({ ...favorite }, {
    target_type: 'answer',
    target_id: 'answer-1',
    project_id: 'project-1',
    node_id: 'node-1',
  });
  const columns = native.prepare('PRAGMA table_info(ai_expansion_jobs)').all().map((row) => row.name);
  assert.ok(columns.includes('context_plan_json'));
  assert.equal((native.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
  native.close();
});

test('project scope settings inherit global and nested topics but can disable one layer', async () => {
  const { native, adapter } = createPersonalContextDatabase();
  const parentId = await createTopic(adapter as never, '机器学习', null);
  const childId = await createTopic(adapter as never, 'Transformer', parentId);
  native.prepare(`UPDATE projects SET topic_id = ? WHERE id = 'project-1'`).run(childId);

  const inherited = await listProjectUnderstandingScopes(adapter as never, 'project-1');
  assert.deepEqual(
    inherited.map((scope) => [scope.scopeType, scope.scopeId, scope.enabled]),
    [
      ['global', 'global', true],
      ['topic', parentId, true],
      ['topic', childId, true],
      ['project', 'project-1', true],
    ],
  );

  await setProjectUnderstandingScopeEnabled(adapter as never, 'project-1', 'topic', parentId, false);
  const updated = await listProjectUnderstandingScopes(adapter as never, 'project-1');
  assert.equal(updated.find((scope) => scope.scopeId === parentId)?.enabled, false);
  native.close();
});

test('question-driven context selects relevant preferences and bound favorites from active layers', async () => {
  const { native, adapter } = createPersonalContextDatabase();
  await saveUnderstandingDocument(adapter as never, {
    scopeType: 'global',
    scopeId: 'global',
    category: 'preference',
    title: '讲解方式',
    body: '先说人话和直觉，再给出数学公式。',
  });
  await saveUnderstandingDocument(adapter as never, {
    scopeType: 'project',
    scopeId: 'project-1',
    category: 'known',
    title: '已经掌握',
    body: '已经熟悉向量点积和矩阵乘法。',
  });
  await setFavoriteBinding(adapter as never, 'favorite-answer-answer-1', 'global', 'global', true);

  const personal = await loadPersonalContextEvidence(
    adapter as never,
    'project-1',
    '请用人话解释缩放点积注意力和向量点积的关系',
  );
  assert.ok(personal.evidence.some((item) => item.category === 'preference'));
  assert.ok(personal.evidence.some((item) => item.category === 'known'));
  assert.ok(personal.evidence.some((item) => item.category === 'favorite'));
  assert.ok(personal.scopes.some((scope) => scope.scopeType === 'global' && scope.enabled));
  native.close();
});

function createPersonalContextDatabase() {
  const native = new DatabaseSync(':memory:');
  native.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
      title TEXT NOT NULL
    );
    CREATE TABLE ai_expansion_jobs (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE node_answers (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      body TEXT NOT NULL,
      is_saved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE local_backup_settings (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE local_backup_jobs (
      id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      requested_at TEXT,
      last_error TEXT
    );
    INSERT INTO local_backup_settings VALUES (1, 0);
    INSERT INTO local_backup_jobs VALUES (1, 0, 'idle', NULL, NULL);
    INSERT INTO projects VALUES ('project-1', '理解 Transformer', 'now', 'now');
    INSERT INTO documents VALUES ('document-1', 'project-1', '缩放点积注意力', '# 缩放点积注意力\\n\\n公式与解释');
    INSERT INTO nodes VALUES ('node-1', 'project-1', 'document-1', '缩放点积注意力');
    INSERT INTO node_answers VALUES (
      'answer-1',
      'project-1',
      'node-1',
      '为什么要缩放？',
      '因为点积方差会随维度增大。',
      1,
      'now',
      'now'
    );
    ${PERSONAL_CONTEXT_MIGRATION_SQL}
  `);
  const adapter = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = native.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstAsync: async <T>(sql: string, ...params: unknown[]) =>
      (native.prepare(sql).get(...params as never[]) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: unknown[]) =>
      native.prepare(sql).all(...params as never[]) as T[],
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
