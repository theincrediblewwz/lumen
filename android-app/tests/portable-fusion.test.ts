import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { beginConversationTurn, createConversation, listMessages, saveDiscussionAsNode, updateConversationReply } from '../data/conversations';
import { createPortableManifest, importPortableManifestWithMapping, parsePortableManifest } from '../data/portable-knowledge';
import { importLocalBackupAsCopies, parseLocalBackupSnapshot } from '../data/local-backup-import';
import type { LocalBackupSnapshot } from '../data/local-backup-format';

async function database() {
  const raw = new DatabaseSync(':memory:'); let failMessages = false;
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => { if (failMessages && sql.startsWith('INSERT INTO conversation_messages')) throw new Error('injected disk full'); return raw.prepare(sql).run(...args); },
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (callback: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE'); try { await callback(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = api as unknown as SQLiteDatabase; await migrateDatabase(db);
  return { db, raw, failNextMessages: () => { failMessages = true; } };
}
async function seedDiscussion(db: SQLiteDatabase) {
  const id = await createConversation(db, 'project-transformer', 'node-transformer', '为什么注意力有用');
  const turn = await beginConversationTurn(db, id, '请解释注意力');
  await updateConversationReply(db, turn.assistantId, '# 注意力\n\n保留数学 $QK^T$。', 'complete', 'synthetic');
  const saved = await saveDiscussionAsNode(db, { title: '从对话得到的理解', conversationId: id });
  await db.runAsync('INSERT INTO reading_positions VALUES(?,?,?,?,?)', saved.documentId, saved.documentId, 'block:stable-heading:1', 0.35, 'now');
  await db.runAsync('UPDATE edges SET relation_kind=?,directed=?,label=? WHERE id=?', 'related', 0, '一起理解', 'edge-root-attention');
  return { id, saved };
}
function backup(projects: LocalBackupSnapshot['projects']): LocalBackupSnapshot {
  return { format: 'learnstuff-app-backup', version: 4, exportedAt: 'now', revision: 1, projects, answers: [], promptTemplates: [], topics: [], aiUnderstandingDocuments: [], projectAiScopeSettings: [], favorites: [], favoriteBindings: [], exclusions: ['original binary attachments', 'credentials'] };
}

test('portable v3 restores multiple documents, conversations and capture provenance with remapped IDs', async () => {
  const { db, raw } = await database(); const { id, saved } = await seedDiscussion(db);
  await db.runAsync('INSERT INTO node_documents VALUES(?,?,?,?)', 'secondary', 'node-transformer', saved.documentId, 1);
  const manifest = await createPortableManifest(db, 'project-transformer');
  assert.equal(manifest.version, 3); assert.equal(manifest.fusion?.conversations.length, 1);
  const map = await importPortableManifestWithMapping(db, parsePortableManifest(JSON.stringify(manifest)));
  const imported = await createPortableManifest(db, map.projectId); const chat = imported.fusion!.conversations[0];
  assert.notEqual(chat.id, id); assert.equal(chat.node_id, map.nodeIds.get('node-transformer'));
  assert.equal(imported.fusion!.nodeDocuments.length, manifest.fusion!.nodeDocuments.length);
  assert.deepEqual(imported.fusion!.messages.map((m) => m.body), manifest.fusion!.messages.map((m) => m.body));
  const provenance = imported.fusion!.conversationDocuments[0];
  assert.equal(provenance.document_id, map.documentIds.get(saved.documentId));
  assert.equal(provenance.node_id, map.nodeIds.get(saved.nodeId!));
  assert.deepEqual(JSON.parse(provenance.message_ids_json), (await listMessages(db, chat.id)).map((m) => m.id));
  const repeated = await saveDiscussionAsNode(db, { title: '仍然是同一份', conversationId: chat.id });
  assert.equal(repeated.reused, true); assert.equal(repeated.documentId, provenance.document_id);
  assert.equal(imported.fusion!.readingPositions[0].id, map.documentIds.get(saved.documentId));
  assert.equal(imported.fusion!.readingPositions[0].anchor, 'block:stable-heading:1');
  assert.equal(imported.fusion!.readingPositions[0].ratio, 0.35);
  assert.equal(imported.fusion!.edgePresentation.find((edge) => edge.id === map.edgeIds.get('edge-root-attention'))?.directed, 0);
  assert.ok(raw.prepare('SELECT id FROM documents WHERE id=?').get(saved.documentId)); raw.close();
});

test('incomplete portable v3 categories and dangling capture messages are rejected before import', async () => {
  const { db, raw } = await database(); await seedDiscussion(db); const manifest = await createPortableManifest(db, 'project-transformer');
  const missing = structuredClone(manifest) as any; delete missing.fusion.messages;
  assert.throws(() => parsePortableManifest(JSON.stringify(missing)), /完整列表/);
  const bad = structuredClone(manifest); bad.fusion!.conversationDocuments[0].message_ids_json = '["unknown"]';
  assert.throws(() => parsePortableManifest(JSON.stringify(bad)), /来源消息/);
  raw.close();
});

test('portable import failure rolls back the new graph and conversation rows while originals remain', async () => {
  const { db, raw, failNextMessages } = await database(); await seedDiscussion(db); const manifest = await createPortableManifest(db, 'project-transformer');
  const before = raw.prepare('SELECT count(*) AS n FROM projects').get(); const beforeChats = raw.prepare('SELECT count(*) AS n FROM conversations').get();
  failNextMessages();
  await assert.rejects(importPortableManifestWithMapping(db, manifest), /disk full/);
  assert.deepEqual(raw.prepare('SELECT count(*) AS n FROM projects').get(), before); assert.deepEqual(raw.prepare('SELECT count(*) AS n FROM conversations').get(), beforeChats);
  assert.equal(raw.prepare('PRAGMA foreign_key_check').get(), undefined); raw.close();
});

test('empty free boards and interrupted conversations survive v4 local backup restore', async () => {
  const { db, raw } = await database(); const { id } = await seedDiscussion(db); await beginConversationTurn(db, id, '下一步');
  await db.runAsync("INSERT INTO projects(id,title,created_at,updated_at,graph_kind) VALUES('empty','空白画布','now','now','free')");
  const snapshot = backup([await createPortableManifest(db, 'project-transformer'), await createPortableManifest(db, 'empty')]);
  const parsed = parseLocalBackupSnapshot(JSON.stringify(snapshot)); const result = await importLocalBackupAsCopies(db, parsed);
  assert.equal(result.sourceVersion, 4); assert.equal(result.projectCount, 2);
  const restored = await createPortableManifest(db, result.projectIds[0]);
  assert.equal(restored.fusion!.messages.some((m) => m.status === 'pending'), false);
  assert.equal(restored.fusion!.messages.some((m) => m.status === 'interrupted'), true);
  assert.equal((await createPortableManifest(db, result.projectIds[1])).fusion!.graphKind, 'free'); raw.close();
});

test('v4 backup metadata failure removes only newly imported copies', async () => {
  const { db, raw } = await database(); await seedDiscussion(db); const manifest = await createPortableManifest(db, 'project-transformer');
  const snapshot = backup([manifest]); snapshot.favorites.push({ id: 'invalid', targetType: 'node', targetId: 'missing', projectId: 'project-transformer', nodeId: 'missing', createdAt: 'now' });
  const before = raw.prepare('SELECT id FROM projects ORDER BY id').all();
  await assert.rejects(importLocalBackupAsCopies(db, snapshot), /收藏/);
  assert.deepEqual(raw.prepare('SELECT id FROM projects ORDER BY id').all(), before);
  assert.equal(raw.prepare('PRAGMA foreign_key_check').get(), undefined); raw.close();
});
