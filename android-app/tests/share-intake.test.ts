import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateDatabase } from '../data/database';
import { previewTextShare } from '../data/share-intake';
import { saveSharedSourceToNode, saveSharedSourcesToNode, type NewSourceItem } from '../data/source-items';
import { createFreeBoard } from '../data/node-workspace';

function share(text: string, mimeType = 'text/plain', subject = '') {
  return { id: 'share-1', text, mimeType, subject, error: null };
}

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).all(...params),
    runAsync: async (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params),
    withExclusiveTransactionAsync: async (action: (db: SQLiteDatabase) => Promise<void>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { await action(adapter as unknown as SQLiteDatabase); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  return { sqlite, db };
}

function input(projectId: string, text = '分享原文'): NewSourceItem {
  return { projectId, kind: 'text', title: '分享标题', originalName: null, mediaType: 'text/plain', assetUri: null,
    sourceUrl: null, contentHash: `hash:${text}`, byteSize: text.length,
    segments: [{ ordinal: 0, locatorType: 'text', locator: '分享文字', body: text, contentHash: `segment:${text}` }] };
}

function count(sqlite: DatabaseSync, table: string) {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('share preview distinguishes public links, markdown and invalid payloads without fetching', () => {
  assert.equal(previewTextShare(share('说明\nhttps://example.com/a#part')).sourceUrl, 'https://example.com/a');
  assert.equal(previewTextShare(share('http://localhost/private')).kind, 'text');
  assert.equal(previewTextShare(share('# 笔记', 'text/markdown')).kind, 'markdown');
  assert.equal(previewTextShare(share('资料', 'text/plain', '主题')).title, '主题');
  assert.throws(() => previewTextShare(share('')), /没有可保存/);
  assert.throws(() => previewTextShare({ ...share('a'), error: '文件流' }), /文件流/);
});

test('shared text creates one document and node, reuses duplicate, and can attach to an existing node', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '目标白板', '# 原节点');
  const first = await saveSharedSourceToNode(db, input(board.projectId), { kind: 'new', title: '新节点' });
  assert.equal(first.reused, false);
  assert.equal((sqlite.prepare('SELECT document_id FROM nodes WHERE id = ?').get(first.nodeId) as { document_id: string }).document_id, first.documentId);
  assert.equal((sqlite.prepare('SELECT body FROM documents WHERE id = ?').get(first.documentId) as { body: string }).body.includes('分享原文'), true);
  const before = ['source_items', 'documents', 'nodes', 'source_segments'].map(table => count(sqlite, table));
  const again = await saveSharedSourceToNode(db, input(board.projectId), { kind: 'new', title: '重复' });
  assert.equal(again.reused, true);
  assert.equal(again.nodeId, first.nodeId);
  assert.deepEqual(['source_items', 'documents', 'nodes', 'source_segments'].map(table => count(sqlite, table)), before);
  const attached = await saveSharedSourceToNode(db, input(board.projectId), { kind: 'existing', nodeId: board.nodeId });
  assert.equal(attached.documentId, first.documentId);
  assert.ok(sqlite.prepare('SELECT 1 FROM node_documents WHERE node_id = ? AND document_id = ?').get(board.nodeId, first.documentId));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('invalid destination and failed transaction leave no partial shared source or node', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '白板一', '正文');
  const other = await createFreeBoard(db, '白板二', '正文');
  const before = ['source_items', 'documents', 'nodes'].map(table => count(sqlite, table));
  await assert.rejects(saveSharedSourceToNode(db, input(board.projectId), { kind: 'existing', nodeId: other.nodeId }), /不属于目标白板/);
  assert.deepEqual(['source_items', 'documents', 'nodes'].map(table => count(sqlite, table)), before);
  sqlite.exec("CREATE TRIGGER reject_shared_source BEFORE INSERT ON source_items BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(saveSharedSourceToNode(db, input(board.projectId), { kind: 'new', title: '失败节点' }), /injected/);
  assert.deepEqual(['source_items', 'documents', 'nodes'].map(table => count(sqlite, table)), before);
});

test('multi-file share commits two source documents on one node and repeated delivery reuses them', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '资料白板', '起点');
  const markdown = { ...input(board.projectId, '# 共享笔记'), kind: 'markdown' as const, originalName: 'notes.md', mediaType: 'text/markdown', assetUri: 'file:///private/notes.md' };
  const pdf = { ...input(board.projectId, 'PDF 第一页正文'), kind: 'pdf' as const, originalName: 'reading.pdf', mediaType: 'application/pdf', assetUri: 'file:///private/reading.pdf' };
  const singleton = await saveSharedSourceToNode(db, markdown, { kind: 'new', title: '单份笔记' });
  const first = await saveSharedSourcesToNode(db, [markdown, pdf], { kind: 'new', title: '一起学习' });
  assert.equal(first.documentIds.length, 2);
  assert.deepEqual(first.reused, [true, false]);
  assert.notEqual(first.nodeId, singleton.nodeId);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM node_documents WHERE node_id=?').get(first.nodeId) as { n: number }).n, 2);
  assert.equal(count(sqlite, 'source_items'), 2);
  sqlite.prepare('UPDATE node_documents SET sort_order = 0 WHERE node_id = ?').run(singleton.nodeId);
  const before = ['nodes', 'documents', 'source_items', 'source_segments', 'node_documents'].map(table => count(sqlite, table));
  const again = await saveSharedSourcesToNode(db, [markdown, pdf], { kind: 'new', title: '重复投递' });
  assert.equal(again.nodeId, first.nodeId);
  assert.deepEqual(again.reused, [true, true]);
  assert.deepEqual(['nodes', 'documents', 'source_items', 'source_segments', 'node_documents'].map(table => count(sqlite, table)), before);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a failed item in a multi-file share rolls back every document, source and node', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '完整批次', '起点');
  const one = { ...input(board.projectId, '第一份'), kind: 'markdown' as const, assetUri: 'file:///private/first.md' };
  const two = { ...input(board.projectId, '第二份'), kind: 'markdown' as const, assetUri: 'file:///private/second.md' };
  const before = ['nodes', 'documents', 'source_items', 'source_segments'].map(table => count(sqlite, table));
  sqlite.exec("CREATE TRIGGER reject_second_share BEFORE INSERT ON source_items WHEN NEW.content_hash='hash:第二份' BEGIN SELECT RAISE(ABORT, 'second item failed'); END");
  await assert.rejects(saveSharedSourcesToNode(db, [one, two], { kind: 'new', title: '批次' }), /second item failed/);
  assert.deepEqual(['nodes', 'documents', 'source_items', 'source_segments'].map(table => count(sqlite, table)), before);
  await assert.rejects(saveSharedSourcesToNode(db, [one], { kind: 'existing', nodeId: 'node-outside' }), /不属于目标白板/);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
