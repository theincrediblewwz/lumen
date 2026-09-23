import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { beginConversationTurn, createConversation, insertManualEdge, updateConversationReply } from '../data/conversations';
import { addNodeDocument, createFreeBoard, createManualNode, listNodeDocuments } from '../data/node-workspace';
import { DISCUSSION_SERIALIZED_LIMIT, prepareDiscussion } from '../ai/discussion-context';

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
  const db = adapter as unknown as SQLiteDatabase; await migrateDatabase(db); return { sqlite, db };
}
type Fragment = { id: string; title: string; body: string; truncated: boolean; citations: { sourceItemId: string; sourceTitle: string; locator: string; quote: string; quoteTruncated: boolean }[]; citationsOmitted: boolean };
function payload(content: string) { return JSON.parse(content.slice(content.indexOf('\n') + 1)); }
function addCitation(sqlite: DatabaseSync, projectId: string, documentId: string, id: string, quote = '确切的引用原文。') {
  const now = '2026-09-22T00:00:00.000Z';
  sqlite.prepare('INSERT INTO source_items (id,project_id,kind,title,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`source-${id}`, projectId, 'markdown', `引用来源 ${id}`, 'text/markdown', `source-hash-${id}`, 20, 'ready', documentId, now, now);
  sqlite.prepare('INSERT INTO source_citations VALUES (?,?,?,?,?,?,?,?)').run(`citation-${id}`, projectId, 'document', documentId, `source-${id}`, 'paragraph:2', quote, now);
}

test('node discussion excludes duplicate primary document and includes exact secondary-document citations in preview', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '当前节点', '独特主文档内容'); const primary = (await listNodeDocuments(db, board.nodeId))[0];
  const secondary = await addNodeDocument(db, board.nodeId, '第二资料', '第二资料独有正文 $x^2$');
  addCitation(sqlite, board.projectId, secondary, 'secondary'); addCitation(sqlite, board.projectId, primary.id, 'primary');
  const chat = await createConversation(db, board.projectId, board.nodeId, '讨论');
  const prepared = await prepareDiscussion(db, chat, '两份资料如何联系？');
  const main = payload(prepared.messages.find(message => message.content.startsWith('以下 JSON'))!.content);
  const extra = payload(prepared.messages.find(message => message.content.startsWith('当前节点额外'))!.content) as { documents: Fragment[]; omittedDocuments: number };
  assert.equal(main.primaryDocumentId, primary.id); assert.equal(main.primaryDocumentSources.citations[0].sourceItemId, 'source-primary');
  assert.deepEqual(extra.documents.map(doc => doc.id), [secondary]);
  assert.deepEqual(extra.documents[0].citations[0], { sourceItemId: 'source-secondary', sourceTitle: '引用来源 secondary', locator: 'paragraph:2', quote: '确切的引用原文。', quoteTruncated: false });
  assert.equal(prepared.omittedDocuments, 0);
  assert.equal(prepared.preview, prepared.messages.map(message => `## ${message.role}\n\n${message.content}`).join('\n\n'));
  assert.match(prepared.preview, /source-secondary/); assert.match(prepared.preview, /paragraph:2/);
});

test('discussion preserves related/followup semantics and omits invented goal paths on a free board', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '自由白板', '起点正文');
  const neighbor = await createManualNode(db, { projectId: board.projectId, title: '相邻资料', body: '相邻资料正文' });
  await insertManualEdge(db, board.projectId, neighbor, board.nodeId, 'related', '无方向相关');
  await insertManualEdge(db, board.projectId, board.nodeId, neighbor, 'followup', '继续追问');
  assert.deepEqual(sqlite.prepare('SELECT DISTINCT relation FROM edges WHERE project_id=?').all(board.projectId).map(row => row.relation), ['support']);
  for (const selected of [board.nodeId, neighbor]) {
    const chat = await createConversation(db, board.projectId, selected, '讨论');
    const prepared = await prepareDiscussion(db, chat, '两个节点如何联系？');
    const reference = payload(prepared.messages.find(message => message.content.startsWith('以下 JSON'))!.content);
    assert.deepEqual(reference.pathFromGoal, []);
    assert.equal(reference.directConnections.length, 2);
    const related = reference.directConnections.find((edge: { relation_kind: string }) => edge.relation_kind === 'related');
    const followup = reference.directConnections.find((edge: { relation_kind: string }) => edge.relation_kind === 'followup');
    assert.equal(related.relation, 'related'); assert.equal(related.directed, false);
    assert.equal(related.direction, 'undirected'); assert.equal(related.label, '无方向相关');
    assert.equal(followup.relation, 'followup'); assert.equal(followup.directed, true);
    assert.equal(followup.direction, selected === board.nodeId ? 'fromCurrent' : 'towardCurrent');
    assert.equal(followup.label, '继续追问');
    assert.doesNotMatch(JSON.stringify(reference.directConnections), /support/);
    assert.match(prepared.preview, /无方向相关/);
  }
});

test('legacy learning relations retain their actual directed semantics and goal path', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '学习目标', '目标正文');
  const neighbor = await createManualNode(db, { projectId: board.projectId, title: '前置知识', body: '知识正文' });
  const edge = await insertManualEdge(db, board.projectId, board.nodeId, neighbor, 'followup');
  sqlite.prepare("UPDATE projects SET graph_kind='learning' WHERE id=?").run(board.projectId);
  // Free-board nodes have no goal order; establish the legacy learning fixture explicitly.
  sqlite.prepare('UPDATE nodes SET sort_order=0 WHERE id=?').run(board.nodeId);
  sqlite.prepare('UPDATE nodes SET sort_order=1 WHERE id=?').run(neighbor);
  sqlite.prepare("UPDATE edges SET relation='prerequisite',relation_kind=NULL WHERE id=?").run(edge);
  const chat = await createConversation(db, board.projectId, neighbor, '讨论');
  const reference = payload((await prepareDiscussion(db, chat, '解释')).messages[1].content);
  assert.equal(reference.directConnections[0].relation, 'prerequisite');
  assert.equal(reference.directConnections[0].relation_kind, null);
  assert.equal(reference.directConnections[0].directed, true);
  assert.equal(reference.directConnections[0].direction, 'towardCurrent');
  assert.equal(reference.directConnections[0].label, '');
  assert.deepEqual(reference.pathFromGoal.map((item: { relationFromPrevious: string | null }) => item.relationFromPrevious), [null, 'prerequisite']);
});

test('secondary references have bounded excerpts, accurate omission metadata and safe Unicode truncation', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '文档预算', '主文档');
  for (let index = 0; index < 8; index++) await addNodeDocument(db, board.nodeId, `文档${index}`, '🌍'.repeat(4000));
  const chat = await createConversation(db, board.projectId, board.nodeId, '讨论');
  const prepared = await prepareDiscussion(db, chat, '说明资料');
  const extra = payload(prepared.messages.find(message => message.content.startsWith('当前节点额外'))!.content) as { documents: Fragment[]; omittedDocuments: number };
  assert.equal(extra.documents.length, 3); assert.equal(extra.omittedDocuments, 5); assert.equal(prepared.omittedDocuments, 5);
  assert.equal(extra.documents.reduce((sum, doc) => sum + doc.body.length, 0), 12000);
  for (const doc of extra.documents) { assert.equal(doc.truncated, true); assert.equal(doc.body.length % 2, 0); assert.ok(doc.body.length <= 5000); }
  assert.equal(prepared.preview.includes('"omittedDocuments":5'), true);
});

test('whole-board questions retrieve only matching current-project documents, cap six excerpts and disclose omitted scope', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '自由图谱', '主文档没有检索词');
  for (let index = 0; index < 8; index++) await createManualNode(db, { projectId: board.projectId, title: `quantum ${index}`, body: '相关 quantum 资料。' + '内容'.repeat(2000) });
  const outside = await createFreeBoard(db, 'quantum 另一个项目', 'DO_NOT_SEND_OTHER_PROJECT');
  assert.ok(outside.projectId);
  const chat = await createConversation(db, board.projectId, null, '图谱讨论');
  const prepared = await prepareDiscussion(db, chat, 'Explain quantum');
  const reference = payload(prepared.messages[1].content) as { source: string; documents: Fragment[]; retrieval: { totalDocuments: number; omittedDocuments: number; scope: string } };
  assert.equal(reference.source, ''); assert.equal(reference.documents.length, 6);
  assert.equal(reference.retrieval.totalDocuments, 9); assert.equal(reference.retrieval.omittedDocuments, 3); assert.equal(prepared.omittedDocuments, 3);
  assert.equal(reference.retrieval.scope, 'current_project_only');
  for (const doc of reference.documents) { assert.ok(doc.title.includes('quantum')); assert.ok(doc.body.length <= 2500); assert.equal(doc.truncated, true); }
  assert.doesNotMatch(prepared.preview, /DO_NOT_SEND_OTHER_PROJECT/); assert.match(prepared.preview, /并非整库/);
});

test('board LIKE matching escapes literal underscore and carries selected-document provenance', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, 'project', 'no keyword');
  const exactNode = await createManualNode(db, { projectId: board.projectId, title: 'alpha_beta', body: 'exact result' });
  await createManualNode(db, { projectId: board.projectId, title: 'alphaXbeta', body: 'wrong wildcard result' });
  const exact = (await listNodeDocuments(db, exactNode))[0]; addCitation(sqlite, board.projectId, exact.id, 'exact');
  const chat = await createConversation(db, board.projectId, null, 'discussion');
  const reference = payload((await prepareDiscussion(db, chat, 'alpha_beta')).messages[1].content) as { documents: Fragment[] };
  assert.deepEqual(reference.documents.map(doc => doc.id), [exact.id]); assert.equal(reference.documents[0].citations[0].sourceItemId, 'source-exact');
});

test('question without searchable terms uses an explicitly labelled recent-document subset', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '可读资料', '现有正文');
  const chat = await createConversation(db, board.projectId, null, '讨论');
  const reference = payload((await prepareDiscussion(db, chat, '？')).messages[1].content);
  assert.equal(reference.retrieval.selection, 'recent_documents');
  assert.equal(reference.documents.length, 1); assert.equal(reference.documents[0].body, '现有正文');
});

test('whole-board discussion keeps source-bounded summary policy without asking the model to generate graph nodes', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '原文整理', '资料只包含当前事实。');
  sqlite.prepare("UPDATE projects SET mode='summary',allow_outside_knowledge=0 WHERE id=?").run(board.projectId);
  for (const nodeId of [null, board.nodeId]) {
    const chat = await createConversation(db, board.projectId, nodeId, '讨论');
    const prepared = await prepareDiscussion(db, chat, '资料');
    assert.match(prepared.messages[0].content, /资料中没有/);
    assert.doesNotMatch(prepared.messages[0].content, /再提炼图谱节点|每个新节点都应|层级关系优先使用 contains/);
    assert.match(prepared.messages[0].content, /本次只回答当前讨论/);
  }
});

test('citation quotas and long quotation truncation are explicitly visible in the transmitted preview', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '引用预算', '主文档'); const secondary = await addNodeDocument(db, board.nodeId, '资料', '补充资料');
  for (let index = 0; index < 22; index++) addCitation(sqlite, board.projectId, secondary, `q${String(index).padStart(2, '0')}`, '🌍'.repeat(400));
  const chat = await createConversation(db, board.projectId, board.nodeId, '讨论');
  const prepared = await prepareDiscussion(db, chat, '解释');
  const doc = payload(prepared.messages.find(message => message.content.startsWith('当前节点额外'))!.content).documents[0] as Fragment;
  assert.equal(doc.citations.length, 20); assert.equal(doc.citationsOmitted, true);
  assert.equal(doc.citations[0].quote.length, 500); assert.equal(doc.citations[0].quoteTruncated, true);
  assert.match(prepared.preview, /"citationsOmitted":true/); assert.match(prepared.preview, /"quoteTruncated":true/);
});

test('serialized request budget catches nested escaping before any new user or pending assistant is created', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '预算边界', '\\'.repeat(10000));
  for (let index = 0; index < 3; index++) await addNodeDocument(db, board.nodeId, `escape ${index}`, '\\'.repeat(5000));
  const chat = await createConversation(db, board.projectId, board.nodeId, '讨论');
  const prior = await beginConversationTurn(db, chat, 'x'.repeat(10000)); await updateConversationReply(db, prior.assistantId, 'y'.repeat(10000), 'complete', null);
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get();
  await assert.rejects(prepareDiscussion(db, chat, 'z'.repeat(12000)), /序列化后超过/);
  assert.deepEqual(sqlite.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get(), before);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE status='pending'").get() as { n: number }).n, 0);
  const short = await createFreeBoard(db, '短图', '简短内容'); const shortChat = await createConversation(db, short.projectId, null, '短讨论');
  const prepared = await prepareDiscussion(db, shortChat, '简短内容'); assert.ok(JSON.stringify(prepared.messages).length <= DISCUSSION_SERIALIZED_LIMIT);
});

test('corrupt cross-project conversation/node links are rejected before reading external node data', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const a = await createFreeBoard(db, 'A', 'A text'); const b = await createFreeBoard(db, 'B', 'B private text');
  const chat = await createConversation(db, a.projectId, a.nodeId, 'conversation');
  sqlite.prepare('UPDATE conversations SET node_id=? WHERE id=?').run(b.nodeId, chat);
  await assert.rejects(prepareDiscussion(db, chat, '说明'), /不属于当前图谱/);
});
