import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { composeReadingQuestion, createReadingReference, parseReadingQuestion, parseReadingReference, readableReadingText, readingReferenceUrl, referenceBlocks, resolveReadingReference } from '../data/reading-reference';
import { readingBlocks } from '../data/reading-position';
import { migrateDatabase } from '../data/database';
import { createFreeBoard, listNodeDocuments } from '../data/node-workspace';
import { beginConversationTurn, createConversation, listMessages, saveDiscussionAsNode, updateConversationReply } from '../data/conversations';
import { prepareDiscussion } from '../ai/discussion-context';
import { createPortableManifest, importPortableManifestWithMapping } from '../data/portable-knowledge';
import { importLocalBackupAsCopies } from '../data/local-backup-import';
import type { LocalBackupSnapshot } from '../data/local-backup-format';

const digest = async (text: string) => createHash('sha256').update(text).digest('hex');
const doc = { id: 'document-local', projectId: 'board-local', title: '中文学习资料', updatedAt: '2026-09-22', body: '# 标题\n\n前段。\n\n相同句子。\n\n相同句子。\n\n结尾。' };
async function fixture() {
  const raw = new DatabaseSync(':memory:'); let fail = false;
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: (string | number | null)[]) => { if (fail && sql.includes('INSERT INTO conversation_messages')) throw new Error('disk full'); return raw.prepare(sql).run(...args); },
    withExclusiveTransactionAsync: async (fn: (db: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE'); try { await fn(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  const db = api as unknown as SQLiteDatabase; await migrateDatabase(db);
  const board = await createFreeBoard(db, '来源白板', '前段。\n\n需要理解的中文段落。\n\n' + '不应泄漏的全文'.repeat(1500));
  const document = (await listNodeDocuments(db, board.nodeId))[0];
  const reference = await createReadingReference(document, 1, 1, digest, { quote: '需要理解', before: '', after: '的中文段落。' });
  const conversation = await createConversation(db, board.projectId, board.nodeId, '选区讨论');
  return { db, raw, board, document, reference, conversation, fail: () => { fail = true; } };
}
test('unchanged document disambiguates identical blocks by exact snapshot and original index', async () => {
  const reference = await createReadingReference(doc, 3, 3, digest);
  assert.deepEqual(await resolveReadingReference(reference, doc, digest), { status: 'exact', index: 3 });
  assert.deepEqual(await resolveReadingReference(reference, { ...doc, body: '新增。\n\n' + doc.body }, digest), { status: 'ambiguous' });
});
test('unique unmodified range relocates; edited, missing and foreign documents never guess a location', async () => {
  const reference = await createReadingReference(doc, 1, 2, digest);
  assert.deepEqual(await resolveReadingReference(reference, { ...doc, body: '新增。\n\n' + doc.body }, digest), { status: 'relocated', index: 2 });
  assert.deepEqual(await resolveReadingReference(reference, { ...doc, body: doc.body.replace('前段。', '前段被改写。') }, digest), { status: 'changed' });
  assert.deepEqual(await resolveReadingReference(reference, null, digest), { status: 'missing' });
  assert.deepEqual(await resolveReadingReference(reference, { ...doc, projectId: 'foreign' }, digest), { status: 'missing' });
});
test('Chinese, fenced code, lists and TeX preserve block indexing and portable source snapshots', async () => {
  const source = { ...doc, body: '# 中英文 🌍\n\n段落 **重点**。\n\n```ts\nconst value = f(x);\n```\n\n- 第一项\n- 第二项\n\n$$\n\\frac{a}{b}\n$$\n\n末尾。' };
  const blocks = referenceBlocks(source.body);
  assert.equal(blocks.length, readingBlocks(source.body).length);
  const ref = await createReadingReference(source, 2, 4, digest);
  assert.match(ref.quote, /const value/); assert.match(ref.quote, /\\frac\{a\}\{b\}/); assert(!ref.quote.includes('learnstuff-math'));
  const stored = composeReadingQuestion(ref, '解释代码和公式');
  assert.deepEqual(parseReadingQuestion(stored), { reference: ref, question: '解释代码和公式' });
  assert.deepEqual(parseReadingReference(readingReferenceUrl(ref)), ref);
  assert(!readableReadingText(stored).includes('learnstuff://')); assert(readableReadingText(stored).includes(ref.title));
  assert(!readingReferenceUrl(ref).includes('(')); assert(!readingReferenceUrl(ref).includes(')'));
});
test('oversize selections reject instead of silently truncating; context respects limits and emoji boundaries', async () => {
  await assert.rejects(createReadingReference({ ...doc, body: '字'.repeat(2401) }, 0, 0, digest), /缩小/);
  await assert.rejects(createReadingReference({ ...doc, body: Array.from({ length: 9 }, (_, i) => String(i)).join('\n\n') }, 0, 8, digest), /8/);
  const ref = await createReadingReference(doc, 1, 1, digest, { quote: '中'.repeat(2400), before: '🌍'.repeat(401), after: '🌍'.repeat(401) });
  assert(ref.before.length <= 400 && ref.after.length <= 400);
  assert.equal(ref.before, '🌍'.repeat(200)); assert.equal(ref.after, '🌍'.repeat(200));
  assert(parseReadingQuestion(composeReadingQuestion(ref, '问题')));
  assert.equal(parseReadingReference('{bad'), null);
  assert.equal(parseReadingReference(readingReferenceUrl({ ...ref, version: 2 } as never)), null);
  assert.equal(parseReadingQuestion(composeReadingQuestion(ref, '问题').replace('> 中', '> 被篡改')), null);
});
test('formula fingerprints never send a NUL sentinel through a native string bridge', async () => {
  const checkedDigest = async (text: string) => { assert(!text.includes('\u0000')); return digest(text); };
  const source = { ...doc, body: '公式 $f(x)$。\n\n$$x^2$$' };
  const ref = await createReadingReference(source, 0, 1, checkedDigest);
  assert.deepEqual(await resolveReadingReference(ref, source, checkedDigest), { status: 'exact', index: 0 });
});
test('selected question preview is bounded, project isolated and identical to actual serialized messages', async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  const body = composeReadingQuestion(f.reference, '为什么？');
  const before = f.raw.prepare('SELECT count(*) n FROM conversation_messages').get();
  const prepared = await prepareDiscussion(f.db, f.conversation, body);
  assert.equal(prepared.preview, prepared.messages.map(m => `## ${m.role}\n\n${m.content}`).join('\n\n'));
  assert(prepared.hasReadingReference); assert.equal(prepared.messages.length, 2);
  assert(prepared.preview.includes('需要理解')); assert(!prepared.preview.includes('不应泄漏的全文'));
  assert(!prepared.preview.includes(f.reference.documentId)); assert(!prepared.preview.includes(f.reference.bodyHash));
  assert.deepEqual(f.raw.prepare('SELECT count(*) n FROM conversation_messages').get(), before, 'preview makes no rows');
  const foreign = composeReadingQuestion({ ...f.reference, projectId: 'foreign' }, '解释');
  await assert.rejects(prepareDiscussion(f.db, f.conversation, foreign), /不属于/);
  await assert.rejects(beginConversationTurn(f.db, f.conversation, foreign), /不属于/);
});
test('persisted source and context survive history, capture, duplicate save and failed send transaction', async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  const body = composeReadingQuestion(f.reference, '解释');
  const turn = await beginConversationTurn(f.db, f.conversation, body);
  await updateConversationReply(f.db, turn.assistantId, '合成回答。', 'complete', 'synthetic');
  assert.equal((await listMessages(f.db, f.conversation))[0].body, body);
  const later = await prepareDiscussion(f.db, f.conversation, composeReadingQuestion(f.reference, '再举例'));
  assert.equal(later.historyCount, 2); assert(!later.preview.includes('learnstuff://')); assert(later.preview.includes('需要理解'));
  const saved = await saveDiscussionAsNode(f.db, { conversationId: f.conversation, title: '理解笔记' });
  assert.equal((await saveDiscussionAsNode(f.db, { conversationId: f.conversation, title: '再保存' })).documentId, saved.documentId);
  const captured = await f.db.getFirstAsync<{ body: string }>('SELECT body FROM documents WHERE id=?', saved.documentId);
  assert(captured?.body.includes(body));
  f.fail(); await assert.rejects(beginConversationTurn(f.db, f.conversation, body), /disk full/);
  assert.equal((await listMessages(f.db, f.conversation)).length, 2);
});
test('portable imports remap reading links in messages and captured documents without touching originals', async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  const body = composeReadingQuestion(f.reference, '解释');
  const turn = await beginConversationTurn(f.db, f.conversation, body);
  await updateConversationReply(f.db, turn.assistantId, '合成回答。', 'complete', 'synthetic');
  const capture = await saveDiscussionAsNode(f.db, { conversationId: f.conversation, title: '引用笔记' });
  const manifest = await createPortableManifest(f.db, f.board.projectId);
  const map = await importPortableManifestWithMapping(f.db, manifest);
  const imported = await createPortableManifest(f.db, map.projectId);
  const ref = parseReadingQuestion(imported.fusion!.messages.find(m => m.role === 'user')!.body)!.reference;
  assert.equal(ref.projectId, map.projectId); assert.equal(ref.documentId, map.documentIds.get(f.document.id)); assert.equal(ref.quote, f.reference.quote);
  const document = { ...imported.documents.find(d => d.id === ref.documentId)!, projectId: map.projectId };
  assert.equal((await resolveReadingReference(ref, document, digest)).status, 'exact');
  const captured = imported.documents.find(d => d.id === map.documentIds.get(capture.documentId))!;
  assert(captured.body.includes(readingReferenceUrl(ref)));
  assert.equal((await listMessages(f.db, f.conversation))[0].body, body);
});
test('backup-as-copies keeps source snapshots and links inside the recovered copy', async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  const turn = await beginConversationTurn(f.db, f.conversation, composeReadingQuestion(f.reference, '解释'));
  await updateConversationReply(f.db, turn.assistantId, '合成回答。', 'complete', 'synthetic');
  const manifest = await createPortableManifest(f.db, f.board.projectId);
  const snapshot: LocalBackupSnapshot = { format: 'learnstuff-app-backup', version: 4, exportedAt: 'now', revision: 1, projects: [manifest], answers: [], promptTemplates: [], topics: [], aiUnderstandingDocuments: [], projectAiScopeSettings: [], favorites: [], favoriteBindings: [], exclusions: [] };
  const result = await importLocalBackupAsCopies(f.db, snapshot);
  const restored = await createPortableManifest(f.db, result.projectIds[0]);
  const ref = parseReadingQuestion(restored.fusion!.messages.find(m => m.role === 'user')!.body)!.reference;
  assert.equal(ref.projectId, result.projectIds[0]); assert(restored.documents.some(d => d.id === ref.documentId)); assert.equal(ref.quote, f.reference.quote);
});
