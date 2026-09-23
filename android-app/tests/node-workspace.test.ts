import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { GraphPatch } from '../ai/graph-patch';
import { migrateDatabase } from '../data/database';
import { beginConversationTurn, createConversation, saveDiscussionAsNode, updateConversationReply } from '../data/conversations';
import { addNodeDocument, attachDocument, connectNodes, createFreeBoard, createManualNode, detachDocument, listNodeDocuments, moveNode, saveDocumentRevision } from '../data/node-workspace';
import { buildExpansionContext, commitGraphPatch, deleteKnowledgeNode, deleteProject, getDocument, getGraph, getLatestAppliedGraphMutationBatch, undoGraphMutationBatch } from '../data/knowledge-repository';
import { readingBlocks, restoreReadingIndex, saveReadingPosition } from '../data/reading-position';

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
function counts(sqlite: DatabaseSync) {
  return Object.fromEntries(['projects','nodes','edges','documents','node_documents','conversations','conversation_messages','conversation_documents','source_items','source_citations'].map(table => [table, (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

test('migrate14 free board supports manual nodes, multiple documents, attachment boundaries and manual positions', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '我的自由图', '# 起点\n\n原文 $x$');
  const graph = await getGraph(db, board.projectId); assert.equal(graph!.project.graphKind, 'free'); assert.equal(graph!.nodes.length, 1);
  const child = await createManualNode(db, { projectId: board.projectId, title: '子问题', body: '手工正文', parentId: board.nodeId });
  const third = await createManualNode(db, { projectId: board.projectId, title: '并列节点', body: '另一个问题' });
  await connectNodes(db, board.projectId, child, third);
  const added = await addNodeDocument(db, child, '第二篇', '更多理解');
  assert.equal((await listNodeDocuments(db, child)).length, 2);
  await attachDocument(db, third, added); await attachDocument(db, third, added);
  assert.equal((await listNodeDocuments(db, third)).length, 2);
  await assert.rejects(attachDocument(db, 'node-transformer', added), /当前图谱/);
  const primary = (await listNodeDocuments(db, child))[0];
  await assert.rejects(detachDocument(db, child, primary.id), /主文档/);
  await detachDocument(db, third, added); assert.ok(await getDocument(db, added));
  await moveNode(db, child, -215.5, 433.25);
  const after = await getGraph(db, board.projectId); assert.equal(after!.nodes.find(node => node.id === child)!.x, -215.5);
  const related = after!.edges.find(edge => edge.sourceId === child && edge.targetId === third)!;
  assert.equal(related.relationKind, 'related'); assert.equal(related.directed, false);
  await assert.rejects(moveNode(db, child, Number.NaN, 0), /位置无效/);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('deleting a free-board first node is allowed and deleting a shared-document node preserves the remaining attachment', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '共享文档', '共享正文');
  const shared = (await listNodeDocuments(db, board.nodeId))[0];
  const remaining = await createManualNode(db, { projectId: board.projectId, title: '保留节点', body: '保留笔记' });
  await attachDocument(db, remaining, shared.id); await moveNode(db, remaining, 731, 122);
  await deleteKnowledgeNode(db, board.nodeId);
  assert.equal((await getDocument(db, shared.id))!.body, '共享正文');
  assert.equal((await listNodeDocuments(db, remaining)).some(doc => doc.id === shared.id), true);
  const graph = await getGraph(db, board.projectId); assert.equal(graph!.nodes.length, 1); assert.equal(graph!.nodes[0].x, 731); assert.equal(graph!.nodes[0].y, 122);
});

test('deleting an entire project removes linked conversations, source references and captured documents without RESTRICT failure', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '删除测试', '源正文'); const original = (await listNodeDocuments(db, board.nodeId))[0];
  const chat = await createConversation(db, board.projectId, board.nodeId, '讨论'); const turn = await beginConversationTurn(db, chat, '问题');
  await updateConversationReply(db, turn.assistantId, '完整回答', 'complete', null); await saveDiscussionAsNode(db, { title: '保存回答', conversationId: chat });
  await addNodeDocument(db, board.nodeId, '补充文档', '补充正文');
  const now = '2026-09-22T00:00:00.000Z';
  sqlite.prepare('INSERT INTO source_items (id,project_id,kind,title,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('source-delete', board.projectId, 'markdown', '原来源', 'text/markdown', 'fixture-delete-hash', 20, 'ready', original.id, now, now);
  sqlite.prepare('INSERT INTO source_citations VALUES (?,?,?,?,?,?,?,?)').run('citation-delete', board.projectId, 'document', original.id, 'source-delete', 'paragraph:1', '原文', now);
  await deleteProject(db, board.projectId);
  assert.equal(await getGraph(db, board.projectId), null);
  for (const table of ['documents','nodes','edges','source_items','source_citations','conversations']) assert.equal((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(board.projectId) as { n: number }).n, 0);
  assert.equal(sqlite.prepare('SELECT 1 FROM conversation_messages WHERE conversation_id=?').get(chat), undefined);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('node deletion cleans only citations to deleted node, answer, edge and documents while preserving the source', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '局部删除', '保留来源');
  const rootDocument = (await listNodeDocuments(db, board.nodeId))[0];
  const child = await createManualNode(db, { projectId: board.projectId, parentId: board.nodeId, title: '删除对象', body: '节点正文' });
  const childDocument = (await listNodeDocuments(db, child))[0];
  const edge = sqlite.prepare('SELECT id,document_id FROM edges WHERE target_id=?').get(child) as { id: string; document_id: string };
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO source_items (id,project_id,kind,title,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('source-keep', board.projectId, 'markdown', '保留来源', 'text/markdown', 'source-keep-hash', 10, 'ready', rootDocument.id, now, now);
  sqlite.prepare('INSERT INTO node_answers (id,project_id,node_id,question,body,adapter,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('answer-delete', board.projectId, child, '问题', '回答', 'local', now, now);
  const targets = [['node', child], ['answer', 'answer-delete'], ['edge', edge.id], ['document', childDocument.id], ['document', edge.document_id], ['document', rootDocument.id]];
  targets.forEach(([kind, id], index) => sqlite.prepare('INSERT INTO source_citations VALUES (?,?,?,?,?,?,?,?)').run(`delete-citation-${index}`, board.projectId, kind, id, 'source-keep', 'paragraph:1', '原文引用', now));
  await deleteKnowledgeNode(db, child);
  const citations = sqlite.prepare('SELECT target_type,target_id FROM source_citations WHERE project_id=?').all(board.projectId);
  assert.deepEqual(citations.map(row => ({ ...row })), [{ target_type: 'document', target_id: rootDocument.id }]);
  assert.ok(sqlite.prepare('SELECT 1 FROM source_items WHERE id=?').get('source-keep'));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('document optimistic save rejects both same-millisecond and remote same-timestamp changes', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const board = await createFreeBoard(db, '并发测试', '原正文'); const doc = (await listNodeDocuments(db, board.nodeId))[0];
  const frozen = new Date('2026-09-22T01:00:00.000Z'); t.mock.timers.enable({ apis: ['Date'], now: frozen });
  const time = frozen.toISOString(); sqlite.prepare('UPDATE documents SET updated_at=? WHERE id=?').run(time, doc.id);
  const savedTime = await saveDocumentRevision(db, doc.id, '第一个编辑', time, '原正文'); assert.equal(savedTime, time);
  await assert.rejects(saveDocumentRevision(db, doc.id, '旧编辑覆盖', time, '原正文'), /别处更新/);
  assert.equal((await getDocument(db, doc.id))!.body, '第一个编辑');
  sqlite.prepare('UPDATE documents SET body=?,updated_at=? WHERE id=?').run('远端新正文', time, doc.id);
  await assert.rejects(saveDocumentRevision(db, doc.id, '本地旧缓冲', time, '第一个编辑'), /别处更新/);
  assert.equal((await getDocument(db, doc.id))!.body, '远端新正文');
  await saveDocumentRevision(db, doc.id, '显式比较后的合并', time, '远端新正文');
  assert.equal((await getDocument(db, doc.id))!.body, '显式比较后的合并');
});

test('reading blocks ignore fenced headings, distinguish duplicate headings and keep math titles readable', () => {
  const markdown = '# 开头\n\n```markdown\n# 代码标题\n```\n\n~~~md\n## 另一代码标题\n~~~\n\n## 重复\n\n正文一。\n\n## 重复\n\n正文二。\n\n## 公式 $E=mc^2$\n\n$$\n\\operatorname{Attention}(Q,K,V)\n=\n\\operatorname{softmax}(QK^T)V\n$$\n';
  const blocks = readingBlocks(markdown); const headings = blocks.filter(block => block.heading !== undefined);
  assert.deepEqual(headings.map(block => block.heading), ['开头','重复','重复','公式 $E=mc^2$']);
  assert.notEqual(headings[1].anchor, headings[2].anchor); assert.equal(new Set(blocks.map(block => block.anchor)).size, blocks.length);
  assert.equal(headings.some(block => block.heading!.includes('learnstuff-math')), false);
  assert.equal(blocks.filter(block => block.depth > 0).length, 4);
});

test('reading restoration follows content anchor after insertion and safely falls back to bounded progress', async t => {
  const original = readingBlocks('# A\n\n先读这一段。\n\n## B\n\n继续阅读。\n'); const anchor = original[3].anchor;
  const changed = readingBlocks('新增前言。\n\n# A\n\n先读这一段。\n\n## B\n\n继续阅读。\n');
  assert.equal(restoreReadingIndex(changed, { anchor, ratio: 0 }), 4);
  assert.equal(restoreReadingIndex(changed, { anchor: 'missing', ratio: 0.5 }), 2);
  assert.equal(restoreReadingIndex(changed, { anchor: 'missing', ratio: Infinity }), 0);
  assert.equal(restoreReadingIndex(changed, { anchor: 'missing', ratio: 100 }), changed.length-1);
  assert.equal(restoreReadingIndex([], { anchor, ratio: 1 }), 0);
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  await saveReadingPosition(db, 'doc-transformer', anchor, 1.4);
  const position = sqlite.prepare('SELECT anchor,ratio FROM reading_positions WHERE document_id=?').get('doc-transformer');
  assert.deepEqual({ ...position }, { anchor, ratio: 1 });
  await saveReadingPosition(db, 'doc-transformer', 'bad', Number.NaN);
  assert.deepEqual(sqlite.prepare('SELECT anchor,ratio FROM reading_positions WHERE document_id=?').get('doc-transformer'), position);
});

async function generated(db: SQLiteDatabase, sqlite: DatabaseSync) {
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO source_items (id,project_id,kind,title,media_type,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('source-fixture', 'project-transformer', 'markdown', '来源资料', 'text/markdown', 'fixture-source-hash', 20, 'ready', 'doc-transformer', now, now);
  sqlite.prepare('INSERT INTO source_segments VALUES (?,?,?,?,?,?,?)').run('segment-fixture', 'source-fixture', 0, 'paragraph', 'paragraph:1', '概念的原始来源材料。', 'fixture-segment-hash');
  const context = await buildExpansionContext(db, 'node-transformer', '展开一层', 'request-fixture');
  sqlite.prepare('INSERT INTO ai_expansion_jobs (id,project_id,selection_type,selection_id,prompt,adapter,status,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('job-fixture', 'project-transformer', 'node', 'node-transformer', '展开一层', 'local', 'running', '{}', now, now);
  const patch: GraphPatch = { version: 1, summary: '测试展开', nodes: [{ clientId: 'child', title: '新增概念', subtitle: '合成内容', importance: 5, status: 'learning', document: { title: '新增概念', body: '# 新增概念\n\n原始生成内容。' } }], edges: [{ clientId: 'edge', sourceRef: 'selection', targetRef: 'child', relation: 'support', importance: 5, document: { title: '关联', body: '解释关联。' } }] };
  const result = await commitGraphPatch(db, context, patch, 'job-fixture', { adapter: 'local', actualModel: null, body: '合成回答' });
  const batch = await getLatestAppliedGraphMutationBatch(db, 'project-transformer'); assert.ok(batch);
  return { ...result, nodeId: batch.createdNodeIds[0], documentId: batch.createdDocumentIds[0] };
}

test('undo still succeeds for an untouched generated batch after fusion migration', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close());
  const batch = await generated(db, sqlite); await undoGraphMutationBatch(db, batch.batchId);
  assert.equal(sqlite.prepare('SELECT 1 FROM nodes WHERE id=?').get(batch.nodeId), undefined);
  assert.equal((sqlite.prepare('SELECT status FROM graph_mutation_batches WHERE id=?').get(batch.batchId) as { status: string }).status, 'undone');
  const orphanCitations = sqlite.prepare(`SELECT c.id FROM source_citations c WHERE
    (c.target_type='node' AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=c.target_id)) OR
    (c.target_type='edge' AND NOT EXISTS(SELECT 1 FROM edges e WHERE e.id=c.target_id)) OR
    (c.target_type='document' AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=c.target_id)) OR
    (c.target_type='answer' AND NOT EXISTS(SELECT 1 FROM node_answers a WHERE a.id=c.target_id))`).all();
  assert.deepEqual(orphanCitations, []);
  assert.ok(sqlite.prepare("SELECT id FROM source_citations WHERE target_type='answer' AND target_id=?").get(batch.answerId));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const dependency of ['attached-document', 'conversation', 'shared-document'] as const) {
  test(`undo preserves later learner content: ${dependency}`, async t => {
    const { sqlite, db } = await fixture(); t.after(() => sqlite.close()); const batch = await generated(db, sqlite);
    if (dependency === 'attached-document') await addNodeDocument(db, batch.nodeId, '后来理解', '学习者写下的正文');
    if (dependency === 'conversation') { const chat = await createConversation(db, 'project-transformer', batch.nodeId, '后来讨论'); const turn = await beginConversationTurn(db, chat, '继续提问'); await updateConversationReply(db, turn.assistantId, '新对话内容', 'complete', null); }
    if (dependency === 'shared-document') await attachDocument(db, 'node-transformer', batch.documentId);
    const before = counts(sqlite);
    await assert.rejects(undoGraphMutationBatch(db, batch.batchId), /不能|引用|后续|文档|讨论|保存|撤销/);
    assert.deepEqual(counts(sqlite), before);
    assert.ok(sqlite.prepare('SELECT id FROM nodes WHERE id=?').get(batch.nodeId));
    assert.equal((sqlite.prepare('SELECT status FROM graph_mutation_batches WHERE id=?').get(batch.batchId) as { status: string }).status, 'applied');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('undo may remove original generated graph while preserving independently captured answer, document, node and sources', async t => {
  const { sqlite, db } = await fixture(); t.after(() => sqlite.close()); const batch = await generated(db, sqlite);
  const saved = await saveDiscussionAsNode(db, { title: '独立保存为学习文档', answerId: batch.answerId });
  const documentBefore = await getDocument(db, saved.documentId);
  const answerBefore = sqlite.prepare('SELECT * FROM node_answers WHERE id=?').get(batch.answerId);
  const citationsBefore = sqlite.prepare('SELECT * FROM source_citations WHERE target_id IN (?,?) ORDER BY id').all(saved.documentId, saved.nodeId!);
  assert.equal(citationsBefore.length, 2);
  await undoGraphMutationBatch(db, batch.batchId);
  assert.equal(sqlite.prepare('SELECT 1 FROM nodes WHERE id=?').get(batch.nodeId), undefined);
  assert.ok(sqlite.prepare('SELECT 1 FROM nodes WHERE id=?').get(saved.nodeId!));
  assert.deepEqual(await getDocument(db, saved.documentId), documentBefore);
  assert.deepEqual(sqlite.prepare('SELECT * FROM node_answers WHERE id=?').get(batch.answerId), answerBefore);
  assert.deepEqual(sqlite.prepare('SELECT * FROM source_citations WHERE target_id IN (?,?) ORDER BY id').all(saved.documentId, saved.nodeId!), citationsBefore);
  assert.ok(sqlite.prepare('SELECT 1 FROM source_items WHERE id=?').get('source-fixture'));
  assert.ok(sqlite.prepare('SELECT 1 FROM conversation_documents WHERE document_id=? AND source_answer_id=?').get(saved.documentId, batch.answerId));
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
