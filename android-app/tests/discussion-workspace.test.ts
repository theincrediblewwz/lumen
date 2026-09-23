import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { CURRENT_DATABASE_VERSION, migrateDatabase } from '../data/database';
import { beginConversationTurn, createConversation, listMessages, saveDiscussionAsNode, updateConversationReply } from '../data/conversations';

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
const project = 'project-transformer'; const parent = 'node-transformer';
function count(sqlite: DatabaseSync, table: string) { return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
function snapshot(sqlite: DatabaseSync) {
  return Object.fromEntries(['documents','nodes','edges','node_documents','conversation_documents','source_citations','conversation_messages','sync_changes'].map(table => [table, count(sqlite, table)]));
}

test('real SQLite migrates to v14 and conversation capture keeps exact Markdown, LaTeX and node/document links', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  assert.equal((sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, CURRENT_DATABASE_VERSION);
  assert.equal(CURRENT_DATABASE_VERSION, 14);
  const chat = await createConversation(db, project, parent, '积分讨论');
  const question = '  为什么 $\\int_0^1 x^2 dx$？\n\n保留原文空格。  ';
  const answer = '# 推导\n\n$$\n\\int_0^1 x^2 \\,dx=\\frac{1}{3}\n$$\n\n```ts\nconst x = "<tag>";\n```\n\n[来源](https://example.invalid/学习)';
  const turn = await beginConversationTurn(db, chat, question);
  await updateConversationReply(db, turn.assistantId, answer, 'complete', 'fixture-model');
  const result = await saveDiscussionAsNode(db, { title: '保留公式', conversationId: chat });
  assert.equal(result.reused, false); assert.ok(result.nodeId);
  const doc = sqlite.prepare('SELECT body,origin FROM documents WHERE id=?').get(result.documentId) as { body: string; origin: string };
  assert.equal(doc.body, `## 我\n\n${question}\n\n---\n\n## AI\n\n${answer}`);
  assert.equal(doc.origin, 'ai');
  assert.equal((await listMessages(db, chat))[0].body, question);
  const node = sqlite.prepare('SELECT document_id FROM nodes WHERE id=?').get(result.nodeId!) as { document_id: string };
  assert.equal(node.document_id, result.documentId);
  assert.ok(sqlite.prepare('SELECT id FROM node_documents WHERE node_id=? AND document_id=?').get(result.nodeId!, result.documentId));
  assert.ok(sqlite.prepare("SELECT id FROM edges WHERE source_id=? AND target_id=? AND relation_kind='followup' AND directed=1").get(parent, result.nodeId!));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('selection is source ordered and repeated capture is idempotent', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const chat = await createConversation(db, project, parent, '顺序');
  const one = await beginConversationTurn(db, chat, '第一问'); await updateConversationReply(db, one.assistantId, '第一答', 'complete', null);
  const two = await beginConversationTurn(db, chat, '第二问'); await updateConversationReply(db, two.assistantId, '第二答', 'complete', null);
  const result = await saveDiscussionAsNode(db, { title: '选定回答', conversationId: chat, messageIds: [two.assistantId, one.assistantId] });
  assert.equal((sqlite.prepare('SELECT body FROM documents WHERE id=?').get(result.documentId) as { body: string }).body, '## AI\n\n第一答\n\n---\n\n## AI\n\n第二答');
  const before = snapshot(sqlite);
  const duplicate = await saveDiscussionAsNode(db, { title: '再次点击', conversationId: chat, messageIds: [one.assistantId, two.assistantId] });
  assert.deepEqual(duplicate, { ...result, reused: true }); assert.deepEqual(snapshot(sqlite), before);
  assert.equal((sqlite.prepare('SELECT message_ids_json FROM conversation_documents WHERE document_id=?').get(result.documentId) as { message_ids_json: string }).message_ids_json, JSON.stringify([one.assistantId, two.assistantId]));
});

test('cross-conversation, missing, empty and currently generating selections do not create any artifacts', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const a = await createConversation(db, project, parent, 'A'); const b = await createConversation(db, project, null, 'B');
  const turnA = await beginConversationTurn(db, a, 'A?'); const turnB = await beginConversationTurn(db, b, 'B?');
  await updateConversationReply(db, turnA.assistantId, 'A!', 'complete', null);
  const before = snapshot(sqlite);
  for (const ids of [[turnA.userId, turnB.userId], ['not-found'], []]) {
    await assert.rejects(saveDiscussionAsNode(db, { title: '错误选择', conversationId: a, messageIds: ids }), /所选消息/);
  }
  await assert.rejects(saveDiscussionAsNode(db, { title: '生成中', conversationId: b }), /等待回答/);
  assert.deepEqual(snapshot(sqlite), before);
});

test('one pending reply per conversation; restart marks interrupted and preserves partial body', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const chat = await createConversation(db, project, null, '连续讨论');
  const one = await beginConversationTurn(db, chat, '第一问');
  await updateConversationReply(db, one.assistantId, '已经收到的半段 $x$', 'pending', 'fixture-model');
  await assert.rejects(beginConversationTurn(db, chat, '不允许并行第二问'), /当前回答/);
  assert.equal((await listMessages(db, chat)).length, 2);
  await migrateDatabase(db);
  const recovered = await listMessages(db, chat); assert.equal(recovered[1].status, 'interrupted'); assert.equal(recovered[1].body, '已经收到的半段 $x$');
  await updateConversationReply(db, one.assistantId, '迟到的覆盖', 'complete', null);
  assert.equal((await listMessages(db, chat))[1].body, '已经收到的半段 $x$');
  const saved = await saveDiscussionAsNode(db, { title: '保存中断资料', conversationId: chat });
  assert.match((sqlite.prepare('SELECT body FROM documents WHERE id=?').get(saved.documentId) as { body: string }).body, /这条回答在完成前中断/);
  const two = await beginConversationTurn(db, chat, '继续讨论'); assert.ok(two.assistantId);
  assert.equal((await listMessages(db, chat)).length, 4);
});

test('failure at final project update rolls back document, node, relation, capture and sync triggers together', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const chat = await createConversation(db, project, parent, '回滚'); const turn = await beginConversationTurn(db, chat, '问题');
  await updateConversationReply(db, turn.assistantId, '回答', 'complete', null);
  const before = snapshot(sqlite); const syncRevision = sqlite.prepare('SELECT revision FROM sync_control WHERE id=1').get();
  sqlite.exec("CREATE TRIGGER fixture_fail_last BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT,'fixture last write failure'); END;");
  await assert.rejects(saveDiscussionAsNode(db, { title: '不会残留', conversationId: chat }), /fixture last write failure/);
  assert.deepEqual(snapshot(sqlite), before); assert.deepEqual(sqlite.prepare('SELECT revision FROM sync_control WHERE id=1').get(), syncRevision);
  sqlite.exec('DROP TRIGGER fixture_fail_last');
  assert.equal((await saveDiscussionAsNode(db, { title: '重试成功', conversationId: chat })).reused, false);
});

test('capturing a legacy answer copies citations to document and node without changing the source answer', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const now = '2026-09-22T00:00:00.000Z'; const question = '原问题 $x$'; const body = '原答复\n\n$$\\alpha^2$$';
  sqlite.prepare('INSERT INTO node_answers (id,project_id,node_id,question,body,adapter,is_saved,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('old-answer', project, parent, question, body, 'imported', 1, now, now);
  sqlite.prepare('INSERT INTO source_items (id,project_id,kind,title,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('source', project, 'markdown', '原来源', 'text/markdown', 'fixture-hash', 20, 'ready', 'doc-transformer', now, now);
  sqlite.prepare('INSERT INTO source_citations VALUES (?,?,?,?,?,?,?,?)').run('citation-source', project, 'answer', 'old-answer', 'source', 'paragraph:2', '逐字引用 $x$', now);
  const original = sqlite.prepare('SELECT * FROM node_answers WHERE id=?').get('old-answer');
  const result = await saveDiscussionAsNode(db, { title: '从旧回答保存', answerId: 'old-answer' });
  assert.equal((sqlite.prepare('SELECT body FROM documents WHERE id=?').get(result.documentId) as { body: string }).body, `## 我\n\n${question}\n\n## AI\n\n${body}`);
  for (const [type, id] of [['answer','old-answer'], ['document',result.documentId], ['node',result.nodeId!]]) {
    const citation = sqlite.prepare('SELECT source_item_id,locator,quote FROM source_citations WHERE target_type=? AND target_id=?').get(type,id);
    assert.deepEqual({ ...citation }, { source_item_id: 'source', locator: 'paragraph:2', quote: '逐字引用 $x$' });
  }
  assert.deepEqual(sqlite.prepare('SELECT * FROM node_answers WHERE id=?').get('old-answer'), original);
  assert.equal(count(sqlite, 'source_citations'), 3);
  assert.equal((await saveDiscussionAsNode(db, { title: '重复', answerId: 'old-answer' })).reused, true);
  assert.equal(count(sqlite, 'source_citations'), 3);
});
