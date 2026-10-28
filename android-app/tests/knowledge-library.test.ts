import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { KNOWLEDGE_LIBRARY_MIGRATION_SQL } from '../data/knowledge-library-schema';
import { emptyKnowledgeLibrary, saveKnowledgeInLibrary, resolveKnowledgeReferences, copyKnowledgeLibrary, validateKnowledgeLibrary, knowledgeReferenceLinks, type KnowledgeLibrary } from '../data/knowledge-library-core';
import { archiveKnowledgeEntry, bindKnowledgeEntry, loadKnowledgeLibrary, loadKnowledgeReferences, loadKnowledgeReferenceStatus, saveKnowledgeEntry, setKnowledgePolicy } from '../data/knowledge-library';
import { updateProjectContentPolicy } from '../data/knowledge-repository';
import { createProjectContentPolicy } from '../ai/content-policy';
import { createFreeBoard, createManualNode } from '../data/node-workspace';
import { createConversation } from '../data/conversations';
import { prepareDiscussion } from '../ai/discussion-context';
import { createPortableManifest, importPortableManifestWithMapping } from '../data/portable-knowledge';
import { importLocalBackupAsCopies, parseLocalBackupSnapshot } from '../data/local-backup-import';
import { applySyncApplication } from '../data/sync-repository';
import { createSyncState, type SyncEntity } from '../sync/core';
import { captureDesktop, projectDesktop, fileBytes } from '../../src/sync/adapter';
import { decodeKnowledgeFile, encodeKnowledgeFile, importKnowledgeFile } from '../data/knowledge-library-transfer';
import { parseKnowledgeReference } from '../data/knowledge-reference';
import { Lexer } from 'marked';
// Exercise the actual Markdown parser's URL adapter without loading its native renderer.
import { getValidURL } from '../node_modules/react-native-marked/src/utils/url';

test('knowledge links survive the Markdown URL adapter and retain the referenced version', () => {
  const href = 'learnstuff-knowledge://knowledge_qa/revision_original';
  const tokens = Lexer.lexInline(`[自己的理解](${href})`);
  assert.equal(tokens[0].type, 'link');
  const renderedHref = getValidURL('', (tokens[0] as { href: string }).href);
  assert.deepEqual(parseKnowledgeReference(renderedHref), { entryId: 'knowledge_qa', revisionId: 'revision_original' });
  assert.deepEqual(parseKnowledgeReference(href), parseKnowledgeReference(renderedHref));
});

test('knowledge routing rejects unrelated URLs, extra path segments and malformed identifiers', () => {
  for (const href of ['https://host/learnstuff-knowledge://a/b', '//learnstuff-knowledge://a/b',
    'learnstuff-knowledge://a/b/c', 'learnstuff-knowledge://a/b?next=x', 'learnstuff-knowledge://a/%2F',
    `learnstuff-knowledge://${'a'.repeat(129)}/b`]) assert.equal(parseKnowledgeReference(href), null);
});

function fixture() {
  const raw = new DatabaseSync(':memory:'); let fail = false;
  const db = {
    execAsync: async (sql: string) => { raw.exec(sql); if (fail && sql === KNOWLEDGE_LIBRARY_MIGRATION_SQL) throw new Error('injected v19 failure'); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (action: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE'); try { await action(db as unknown as SQLiteDatabase); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return { raw, db: db as unknown as SQLiteDatabase, setFault: (value: boolean) => { fail = value; } };
}
async function database() { const f = fixture(); await migrateDatabase(f.db); return f; }
function sample(): KnowledgeLibrary {
  const { library, entry } = saveKnowledgeInLibrary(emptyKnowledgeLibrary(), { kind: 'material', title: '注意力原始材料', body: '注意力中缩放因子稳定方差。', source: '书第 2 页' });
  return saveKnowledgeInLibrary(library, { kind: 'understanding', title: '我理解的注意力', body: '我把注意力看作按任务选择记忆的过程。', basisIds: [entry.id] }).library;
}
const assets = { install: async () => '', localUri: async () => '', exportFile: async () => { throw new Error('no binary'); } };

test('desktop and Android use the exact same knowledge contract', () => {
  assert.equal(readFileSync(new URL('../data/knowledge-library-core.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../src/knowledge/core.ts', import.meta.url), 'utf8'));
});
test('authored understanding saves directly, stale edits fail, and old cited content stays immutable', () => {
  const library = sample(), old = library.entries[1];
  const saved = saveKnowledgeInLibrary(library, { id: old.id, expectedRevision: old.revision_id, kind: old.kind, title: old.title, body: '新的个人理解', basisIds: JSON.parse(old.basis_json) });
  assert.equal(saved.entry.authorship, 'user');
  assert.equal(saved.library.revisions.find(row => row.id === old.revision_id)?.body, old.body);
  assert.throws(() => saveKnowledgeInLibrary(saved.library, { id: old.id, expectedRevision: old.revision_id, kind: old.kind, title: old.title, body: '旧草稿' }), /已变化/);
  assert.equal(library.revisions.length, 2);
  assert.throws(() => validateKnowledgeLibrary({ ...library, entries: [{ ...old, body: '破坏版本一致性' }], revisions: library.revisions }), /版本|依据/);
});
test('per-board permissions, Chinese relevance, source boundaries and priority budgets fail closed', () => {
  const library = sample(), user = library.entries[1], now = new Date().toISOString();
  assert.deepEqual(resolveKnowledgeReferences(library, 'board', '注意力'), []);
  library.settings.push({ id: 'board', project_id: 'board', policy: 'allowed', updated_at: now });
  assert.equal(resolveKnowledgeReferences(library, 'board', '怎样理解注意力')[0].entryId, user.id);
  assert.deepEqual(resolveKnowledgeReferences(library, 'other', '注意力'), []);
  assert.deepEqual(resolveKnowledgeReferences(library, 'board', '没有相关词汇'), []);
  assert.deepEqual(resolveKnowledgeReferences(library, 'board', '注意力', { sourceBound: true, allowOutside: false }), []);
  assert.deepEqual(resolveKnowledgeReferences(library, 'board', '仅根据原文总结注意力'), []);
  library.settings[0].policy = 'priority';
  assert.throws(() => resolveKnowledgeReferences(library, 'board', '注意力'), /指定条目/);
  library.bindings.push({ id: 'binding', project_id: 'board', node_id: null, entry_id: user.id, created_at: now });
  assert.equal(resolveKnowledgeReferences(library, 'board', '不相关问题')[0].entryId, user.id);
  assert.throws(() => resolveKnowledgeReferences(library, 'board', '注意力', { budget: 1 }), /预算/);
  const ref = resolveKnowledgeReferences(library, 'board', '注意力')[0];
  assert.match(knowledgeReferenceLinks([ref]), new RegExp(`learnstuff-knowledge://${user.id}/${user.revision_id}`));
});
test('v18 to v19 failure rolls back schema, triggers, version and exact original bodies before safe retry', async t => {
  const f = await database(); t.after(() => f.raw.close());
  for (const table of ['knowledge_bindings', 'knowledge_reference_settings', 'knowledge_revisions', 'knowledge_entries']) f.raw.exec(`DROP TABLE ${table}`);
  f.raw.exec('PRAGMA user_version=18');
  const before = f.raw.prepare('SELECT * FROM documents ORDER BY id').all();
  const schema = f.raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  f.setFault(true); await assert.rejects(migrateDatabase(f.db), /injected/);
  assert.equal((f.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18);
  assert.deepEqual(f.raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
  assert.deepEqual(f.raw.prepare('SELECT * FROM documents ORDER BY id').all(), before);
  f.setFault(false); await migrateDatabase(f.db); await migrateDatabase(f.db);
  assert.equal((f.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 19);
  assert.deepEqual(f.raw.prepare('SELECT * FROM documents ORDER BY id').all(), before);
});
test('board removal and unbinding preserve knowledge, history and backup/sync coverage', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const board = (await createFreeBoard(f.db, '独立引用白板', '')).projectId;
  const entry = await saveKnowledgeEntry(f.db, { kind: 'experience', title: '学习经验', body: '先写自己的理解再追问。' });
  await bindKnowledgeEntry(f.db, board, entry.id, null, true); await setKnowledgePolicy(f.db, board, 'priority');
  await bindKnowledgeEntry(f.db, board, entry.id, null, false);
  assert.equal((await loadKnowledgeLibrary(f.db)).entries.length, 1);
  await bindKnowledgeEntry(f.db, board, entry.id, null, true);
  assert.equal((await loadKnowledgeReferences(f.db, board, '学习'))[0].entryId, entry.id);
  await archiveKnowledgeEntry(f.db, entry.id, true, entry.revision_id);
  await assert.rejects(loadKnowledgeReferences(f.db, board, '学习'), /指定条目/);
  await archiveKnowledgeEntry(f.db, entry.id, false, entry.revision_id);
  await f.db.runAsync('DELETE FROM projects WHERE id=?', board);
  const library = await loadKnowledgeLibrary(f.db);
  assert.equal(library.entries.length, 1); assert.equal(library.revisions.length, 1); assert.equal(library.bindings.length, 0); assert.equal(library.settings.length, 0);
  const kinds = new Set(f.raw.prepare('SELECT DISTINCT kind FROM sync_changes').all().map(row => row.kind));
  for (const kind of ['knowledge_entries', 'knowledge_revisions', 'knowledge_bindings', 'knowledge_reference_settings']) assert.ok(kinds.has(kind));
  assert.ok((f.raw.prepare('SELECT revision FROM local_backup_jobs').get() as { revision: number }).revision > 0);
});
test('actual discussion preview includes only authorized knowledge; editing invalidates the exact payload', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const board = (await createFreeBoard(f.db, '注意力学习', '')).projectId;
  const entry = await saveKnowledgeEntry(f.db, { kind: 'understanding', title: '我理解的注意力', body: '注意力是选择记忆的过程。' });
  const conversation = await createConversation(f.db, board, null, '讨论');
  const off = await prepareDiscussion(f.db, conversation, '解释注意力'); assert.equal(off.knowledgeReferences.length, 0);
  await setKnowledgePolicy(f.db, board, 'allowed');
  const on = await prepareDiscussion(f.db, conversation, '解释注意力');
  assert.equal(on.knowledgeReferences[0].entryId, entry.id); assert.ok(on.preview.includes(entry.body));
  assert.equal(on.preview, on.messages.map(m => `## ${m.role}\n\n${m.content}`).join('\n\n'));
  await saveKnowledgeEntry(f.db, { id: entry.id, expectedRevision: entry.revision_id, kind: entry.kind, title: entry.title, body: '注意力是动态选择的过程。' });
  assert.notEqual((await prepareDiscussion(f.db, conversation, '解释注意力')).preview, on.preview);
  assert.equal((await prepareDiscussion(f.db, conversation, '只根据原文解释注意力')).knowledgeReferences.length, 0);
});

test('board authorization display is a read-only, scoped view of persisted permissions and active knowledge', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const first = (await createFreeBoard(f.db, '引用白板一', '')).projectId;
  const second = (await createFreeBoard(f.db, '引用白板二', '')).projectId;
  assert.deepEqual(await loadKnowledgeReferenceStatus(f.db, first), { policy: 'disabled', boundCount: 0 });
  const understanding = await saveKnowledgeEntry(f.db, { kind: 'understanding', title: '注意力理解', body: '这是用户保留的原话。' });
  const material = await saveKnowledgeEntry(f.db, { kind: 'material', title: '注意力材料', body: '这是独立材料。' });
  await bindKnowledgeEntry(f.db, first, understanding.id, null, true);
  await bindKnowledgeEntry(f.db, first, material.id, null, true);
  await setKnowledgePolicy(f.db, first, 'priority');
  assert.deepEqual(await loadKnowledgeReferenceStatus(f.db, first), { policy: 'priority', boundCount: 2 });
  await archiveKnowledgeEntry(f.db, material.id, true, material.revision_id);
  const before = await loadKnowledgeLibrary(f.db);
  assert.deepEqual(await loadKnowledgeReferenceStatus(f.db, first), { policy: 'priority', boundCount: 1 });
  assert.deepEqual(await loadKnowledgeReferenceStatus(f.db, second), { policy: 'disabled', boundCount: 0 });
  assert.deepEqual(await loadKnowledgeLibrary(f.db), before);
});

test('outside supplements and personal knowledge authorization remain separate in real discussion previews', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const board = (await createFreeBoard(f.db, '注意力资料整理', '# 注意力资料')).projectId;
  const entry = await saveKnowledgeEntry(f.db, { kind: 'understanding', title: '自己的注意力理解', body: '我的理解需要独立授权才能给 AI。' });
  await bindKnowledgeEntry(f.db, board, entry.id, null, true);
  const conversation = await createConversation(f.db, board, null, '讨论');
  await updateProjectContentPolicy(f.db, board, createProjectContentPolicy({ mode: 'summary', allowOutsideKnowledge: true }));
  assert.equal((await prepareDiscussion(f.db, conversation, '解释注意力')).knowledgeReferences.length, 0);
  assert.equal((await loadKnowledgeReferenceStatus(f.db, board)).policy, 'disabled');
  await setKnowledgePolicy(f.db, board, 'allowed');
  assert.equal((await prepareDiscussion(f.db, conversation, '解释注意力')).knowledgeReferences[0].revisionId, entry.revision_id);
  await updateProjectContentPolicy(f.db, board, createProjectContentPolicy({ mode: 'summary', allowOutsideKnowledge: false }));
  assert.equal((await loadKnowledgeReferenceStatus(f.db, board)).policy, 'allowed');
  assert.equal((await prepareDiscussion(f.db, conversation, '解释注意力')).knowledgeReferences.length, 0);
  await updateProjectContentPolicy(f.db, board, createProjectContentPolicy({ mode: 'summary', allowOutsideKnowledge: true }));
  assert.equal((await prepareDiscussion(f.db, conversation, '只根据原文解释注意力')).knowledgeReferences.length, 0);
  const retained = await loadKnowledgeLibrary(f.db);
  assert.equal(retained.entries[0].body, entry.body);
  assert.equal(retained.revisions[0].id, entry.revision_id);
});
test('scoped portable copy restores materials, cited old versions, permissions and remapped answer links atomically', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const board = (await createFreeBoard(f.db, '注意力', '# 学习原文')).projectId;
  const material = await saveKnowledgeEntry(f.db, { kind: 'material', title: '依据', body: '原始材料', source: '书' });
  const entry = await saveKnowledgeEntry(f.db, { kind: 'understanding', title: '注意力', body: '我自己的观点', basisIds: [material.id] });
  await saveKnowledgeEntry(f.db, { kind: 'experience', title: '私人其他经验', body: '不应出现在单白板导出' });
  await createManualNode(f.db, { projectId: board, title: '引用', body: `[观点](learnstuff-knowledge://${entry.id}/${entry.revision_id})` });
  await saveKnowledgeEntry(f.db, { id: entry.id, expectedRevision: entry.revision_id, kind: entry.kind, title: entry.title, body: '更新后的观点', basisIds: [material.id] });
  await bindKnowledgeEntry(f.db, board, entry.id, null, true); await setKnowledgePolicy(f.db, board, 'priority');
  const manifest = await createPortableManifest(f.db, board);
  assert.equal(manifest.version, 5); assert.equal(manifest.knowledgeLibrary?.entries.length, 2);
  const copied = await importPortableManifestWithMapping(f.db, manifest);
  const library = await loadKnowledgeLibrary(f.db), binding = library.bindings.find(row => row.project_id === copied.projectId)!;
  assert.notEqual(binding.entry_id, entry.id);
  const old = library.revisions.find(row => row.entry_id === binding.entry_id && row.body === entry.body)!;
  const doc = await f.db.getFirstAsync<{ body: string }>("SELECT body FROM documents WHERE project_id=? AND body LIKE '%learnstuff-knowledge://%'", copied.projectId);
  assert.ok(doc?.body.includes(`learnstuff-knowledge://${binding.entry_id}/${old.id}`));
  assert.equal(library.entries.find(row => row.id === entry.id)?.body, '更新后的观点');
  const before = library.entries.length;
  f.raw.exec("CREATE TRIGGER fail_import_knowledge BEFORE INSERT ON knowledge_bindings BEGIN SELECT RAISE(ABORT,'injected copy failure'); END");
  await assert.rejects(importPortableManifestWithMapping(f.db, manifest), /injected copy/);
  assert.equal((await loadKnowledgeLibrary(f.db)).entries.length, before);
});
test('full v5 backup includes unbound knowledge and shares one remap across all project copies', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const board = (await createFreeBoard(f.db, '备份', '# 学习原文')).projectId, board2 = (await createFreeBoard(f.db, '备份二', '# 学习原文二')).projectId;
  const entry = await saveKnowledgeEntry(f.db, { kind: 'understanding', title: '经验', body: '未绑定也需要备份' });
  for (const projectId of [board, board2]) await createManualNode(f.db, { projectId, title: '引用', body: `[旧理解](learnstuff-knowledge://${entry.id}/${entry.revision_id})` });
  const snapshot = parseLocalBackupSnapshot(JSON.stringify({ format: 'learnstuff-app-backup', version: 5, exportedAt: new Date().toISOString(), revision: 1, projects: await Promise.all([board, board2].map(id => createPortableManifest(f.db, id, false))), answers: [], promptTemplates: [], topics: [], aiUnderstandingDocuments: [], projectAiScopeSettings: [], favorites: [], favoriteBindings: [], exclusions: [], knowledgeLibrary: await loadKnowledgeLibrary(f.db) }));
  const copy = await importLocalBackupAsCopies(f.db, snapshot, ({ current, total }) => { if (current === total) throw new Error('UI only'); });
  const library = await loadKnowledgeLibrary(f.db); assert.equal(library.entries.length, 2);
  const restored = library.entries.find(row => row.id !== entry.id)!;
  for (const projectId of copy.projectIds) assert.ok((await f.db.getFirstAsync<{ body: string }>("SELECT body FROM documents WHERE project_id=? AND body LIKE '%learnstuff-knowledge://%'", projectId))?.body.includes(`learnstuff-knowledge://${restored.id}/${restored.revision_id}`));
  assert.throws(() => parseLocalBackupSnapshot(JSON.stringify({ ...snapshot, knowledgeLibrary: undefined })), /缺少独立知识/);
});
test('independent exchange imports copies and keeps adopted AI authorship without transferring board permission', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const original = sample(); original.entries[1].authorship = 'ai_adopted'; original.revisions[1].authorship = 'ai_adopted';
  const imported = decodeKnowledgeFile(encodeKnowledgeFile(original));
  const copied = copyKnowledgeLibrary(imported); assert.notEqual(copied.library.entries[0].id, original.entries[0].id);
  await importKnowledgeFile(f.db, imported); await importKnowledgeFile(f.db, imported);
  const library = await loadKnowledgeLibrary(f.db); assert.equal(library.entries.length, 4); assert.equal(library.settings.length, 0);
  assert.equal(library.entries.filter(row => row.authorship === 'ai_adopted').length, 2);
  assert.throws(() => decodeKnowledgeFile('{"format":"historyandknowledge"}'), /尚未接入/);
});
test('real desktop projection and SQLite receive global knowledge plus versions with no per-board duplicates', async t => {
  const f = await database(); t.after(() => f.raw.close());
  const library = sample();
  const first = await captureDesktop({ revision: 'synthetic', ledger: null, files: { 'index.json': fileBytes({projects:[]}), 'knowledge/library.json': fileBytes(library) } });
  const entities = Object.values(first.entities); assert.equal(entities.filter(e => e.kind === 'knowledge_entries').length, 2); assert.ok(entities.every(e => e.boardId === null));
  const state = createSyncState('library', 'android');
  f.raw.exec('DELETE FROM sync_changes');
  await applySyncApplication(f.db, { entities, blobs: [], state, conflicts: [], commit: null }, assets);
  assert.deepEqual(normalized(await loadKnowledgeLibrary(f.db)), normalized(library));
  const projected = projectDesktop(first.entities, {});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(projected['knowledge/library.json']))), library);
  const row = entities.find(e => e.kind === 'knowledge_revisions')!;
  await assert.rejects(applySyncApplication(f.db, { entities: [{ ...row, data: { ...row.data, body: 'attempted overwrite' } }], blobs: [], state, conflicts: [], commit: null }, assets), /不能覆盖/);
  assert.equal((await loadKnowledgeLibrary(f.db)).revisions.find(r => r.id === row.id)?.body, row.data?.body);
  await assert.rejects(applySyncApplication(f.db, { entities: [{ ...row, data: null }], blobs: [], state, conflicts: [], commit: null }, assets), /不能删除/);
  assert.equal((f.raw.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number }).n, 0);
  const bad: SyncEntity = { kind: 'knowledge_entries', id: library.entries[0].id, boardId: null, data: { ...library.entries[0], revision_id: 'missing' } };
  await assert.rejects(applySyncApplication(f.db, { entities: [bad], blobs: [], state, conflicts: [], commit: null }, assets), /版本缺失/);
});

function normalized(input: KnowledgeLibrary) { const library = validateKnowledgeLibrary(input); return Object.fromEntries(Object.entries(library).map(([key,value]) => [key, Array.isArray(value) ? [...value].sort((a,b) => a.id.localeCompare(b.id)) : value])); }
