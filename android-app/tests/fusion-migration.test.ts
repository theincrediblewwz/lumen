import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { CURRENT_DATABASE_VERSION, migrateDatabase } from '../data/database';
import { FUSION_MIGRATION_SQL } from '../data/fusion-schema';
import { SYNC_MIGRATION_SQL } from '../data/sync-schema';
import { migrateDatabase as migrateHistoricalV12 } from './fixtures/database-v12';

type Fault = 'after-fusion-ddl' | 'after-sync-ddl' | 'after-sync-version' | null;
const legacyContentTables = [
  'topics', 'projects', 'documents', 'nodes', 'edges', 'node_answers', 'prompt_templates',
  'ai_understanding_documents', 'project_ai_scope_settings', 'favorites', 'favorite_bindings',
  'source_items', 'source_segments', 'source_citations', 'mastery_attempts', 'graph_mutation_batches',
] as const;
const originalMarkdown = '  # 中文原文：积分与注意力\n\n$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$\n\n行内 $QK^{\\mathsf T}/\\sqrt{d_k}$。\n\n```ts\nconst 原文 = "<保持 & 空格>";\n```\n\n[原始来源](https://example.invalid/学习)\n\n末尾空格仍保留。  ';

async function historicalDatabase() {
  const raw = new DatabaseSync(':memory:'); let fault: Fault = null; let injected = false;
  const adapter = {
    execAsync: async (sql: string) => {
      raw.exec(sql);
      if ((fault === 'after-fusion-ddl' && sql === FUSION_MIGRATION_SQL)
        || (fault === 'after-sync-ddl' && sql === SYNC_MIGRATION_SQL)
        || (fault === 'after-sync-version' && /PRAGMA user_version = 14/.test(sql))) {
        injected = true; throw new Error(`Injected migration failure: ${fault}`);
      }
    },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (action: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try { await action(adapter as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as SQLiteDatabase;
  // This creates the actual historic tables/indexes/triggers. No current-schema bootstrap is used.
  await migrateHistoricalV12(db);
  assert.equal(version(raw), 12);
  raw.prepare('UPDATE documents SET body=? WHERE id=?').run(originalMarkdown, 'doc-transformer');
  raw.exec(`
    UPDATE projects SET mode='summary',explanation_style='plain_language',allow_outside_knowledge=0 WHERE id='project-transformer';
    INSERT INTO node_answers(id,project_id,node_id,question,body,adapter,is_saved,created_at,updated_at)
      VALUES('answer-v12','project-transformer','node-transformer','中文旧问题','旧回答：$QK^T$','local',1,'2026-09-20','2026-09-20');
    INSERT INTO source_items(id,project_id,kind,title,media_type,asset_uri,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at)
      VALUES('source-v12','project-transformer','pdf','旧资料','application/pdf','file:///synthetic-private/original.pdf','synthetic-hash',8,'ready','doc-transformer','2026-09-20','2026-09-20');
    INSERT INTO source_segments VALUES('segment-v12','source-v12',0,'page','第 2 页','原始中文摘录','synthetic-segment-hash');
    INSERT INTO source_citations VALUES('citation-v12','project-transformer','node','node-transformer','source-v12','第 2 页','原始中文摘录','2026-09-20');
    INSERT INTO mastery_attempts VALUES('mastery-v12','project-transformer','node-transformer','解释','旧的理解','关键点','passed','2026-09-20');
  `);
  const columns = Object.fromEntries(legacyContentTables.map((table) => [table,
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  ]));
  const content = () => Object.fromEntries(legacyContentTables.map((table) => [table, raw.prepare(`SELECT ${columns[table].join(',')} FROM ${table} ORDER BY rowid`).all()]));
  return { raw, db, content, setFault: (next: Fault) => { fault = next; injected = false; }, wasInjected: () => injected };
}

function version(raw: DatabaseSync) { return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
function schema(raw: DatabaseSync) { return raw.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(); }
function exists(raw: DatabaseSync, table: string) { return Boolean(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function columnExists(raw: DatabaseSync, table: string, name: string) { return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((column) => column.name === name); }
function assertBackfill(raw: DatabaseSync) {
  assert.equal((raw.prepare('SELECT count(*) AS n FROM node_documents').get() as { n: number }).n, (raw.prepare('SELECT count(*) AS n FROM nodes').get() as { n: number }).n);
  assert.deepEqual(raw.prepare(`SELECT n.id FROM nodes n LEFT JOIN node_documents link
    ON link.node_id=n.id AND link.document_id=n.document_id
    WHERE link.id IS NULL OR link.id!='link-'||n.id||'-'||n.document_id OR link.sort_order!=0`).all(), []);
}

test('frozen historical v12 migrates to v14 preserving IDs and exact Chinese Markdown/TeX with idempotent backfill', async (t) => {
  const fixture = await historicalDatabase(); t.after(() => fixture.raw.close());
  const before = fixture.content();
  assert.equal(exists(fixture.raw, 'node_documents'), false); assert.equal(exists(fixture.raw, 'sync_state'), false);
  await migrateDatabase(fixture.db);
  assert.equal(CURRENT_DATABASE_VERSION, 14); assert.equal(version(fixture.raw), 14);
  assert.deepEqual(fixture.content(), before);
  assert.equal((fixture.raw.prepare("SELECT body FROM documents WHERE id='doc-transformer'").get() as { body: string }).body, originalMarkdown);
  assert.equal((fixture.raw.prepare("SELECT graph_kind FROM projects WHERE id='project-transformer'").get() as { graph_kind: string }).graph_kind, 'summary');
  assertBackfill(fixture.raw);
  const afterSchema = schema(fixture.raw); const changes = fixture.raw.prepare('SELECT * FROM sync_changes ORDER BY kind,entity_id').all();
  await migrateDatabase(fixture.db); await migrateDatabase(fixture.db);
  assert.deepEqual(schema(fixture.raw), afterSchema); assert.deepEqual(fixture.content(), before);
  assert.deepEqual(fixture.raw.prepare('SELECT * FROM sync_changes ORDER BY kind,entity_id').all(), changes);
  assertBackfill(fixture.raw); assert.deepEqual(fixture.raw.prepare('PRAGMA foreign_key_check').all(), []);
});

test('failure after v13 fusion DDL rolls schema, backfill and user_version back to real v12, then retry succeeds', async (t) => {
  const fixture = await historicalDatabase(); t.after(() => fixture.raw.close());
  const before = fixture.content(); const oldSchema = schema(fixture.raw);
  fixture.setFault('after-fusion-ddl');
  await assert.rejects(migrateDatabase(fixture.db), /Injected migration failure: after-fusion-ddl/);
  assert.equal(fixture.wasInjected(), true); assert.equal(version(fixture.raw), 12);
  assert.deepEqual(schema(fixture.raw), oldSchema); assert.deepEqual(fixture.content(), before);
  assert.equal(exists(fixture.raw, 'node_documents'), false); assert.equal(columnExists(fixture.raw, 'projects', 'graph_kind'), false);
  fixture.setFault(null); await migrateDatabase(fixture.db);
  assert.equal(version(fixture.raw), 14); assertBackfill(fixture.raw); assert.deepEqual(fixture.content(), before);
  assert.deepEqual(fixture.raw.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const fault of ['after-sync-ddl', 'after-sync-version'] as const) {
  test(`failure ${fault} retains committed v13 while rolling back all v14 sync tables and triggers, then retry succeeds`, async (t) => {
    const fixture = await historicalDatabase(); t.after(() => fixture.raw.close());
    const before = fixture.content();
    fixture.setFault(fault);
    await assert.rejects(migrateDatabase(fixture.db), new RegExp(`Injected migration failure: ${fault}`));
    assert.equal(fixture.wasInjected(), true); assert.equal(version(fixture.raw), 13);
    assert.deepEqual(fixture.content(), before); assertBackfill(fixture.raw);
    assert.equal(exists(fixture.raw, 'conversations'), true); assert.equal(columnExists(fixture.raw, 'projects', 'graph_kind'), true);
    assert.equal(exists(fixture.raw, 'sync_control'), false); assert.equal(exists(fixture.raw, 'sync_state'), false);
    assert.deepEqual(fixture.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sync_track_%'").all(), []);
    fixture.setFault(null); await migrateDatabase(fixture.db);
    assert.equal(version(fixture.raw), 14); assert.equal(exists(fixture.raw, 'sync_state'), true);
    assert.deepEqual(fixture.content(), before); assertBackfill(fixture.raw);
    assert.deepEqual(fixture.raw.prepare('PRAGMA foreign_key_check').all(), []);
  });
}
