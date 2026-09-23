import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { SYNC_MIGRATION_SQL, SYNC_TABLES } from '../data/sync-schema';
import { acquireSyncLease, applySyncApplication, captureLocalChanges, keepLocalBlockedSync, listBlockedSync, listSyncConflicts, loadSyncState, releaseSyncLease, resolveSyncConflict, saveSyncConfiguration, type SyncAssets } from '../data/sync-repository';
import { createSyncState, entityKey, getConflicts, queueLocalChanges, synchronize } from '../sync/core';
import type { BlobRef, SyncEntity, SyncState, SyncTransport } from '../sync/core';
import { basicAuthorization } from '../sync/authorization';
import { installVerifiedBlob } from '../sync/blob-installation';
import { createFreeBoard, listNodeDocuments } from '../data/node-workspace';
import { beginConversationTurn, createConversation, listMessages, updateConversationReply } from '../data/conversations';
import { composeReadingQuestion, createReadingReference, parseReadingQuestion, resolveReadingReference } from '../data/reading-reference';

const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('native Basic authentication encodes UTF-8 without requiring browser btoa', () => {
  for (const [username, password] of [['a', 'b'], ['long-user', ''], ['用户😀', '应用密码:含冒号'], ['', '1'], ['abc', '12345']]) {
    assert.equal(basicAuthorization(username, password), `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`);
  }
  assert.throws(() => basicAuthorization('invalid:user', 'secret'), /用户名/);
});
test('interrupted attachment publication retries safely and cleanup never deletes the moved final file', async () => {
  const files = new Map<string, Uint8Array>(); let failMove = true;
  class MemoryFile {
    constructor(public uri: string) {}
    get exists() { return files.has(this.uri); }
    async bytes() { return files.get(this.uri)!; }
    write(bytes: Uint8Array) { files.set(this.uri, bytes.slice()); }
    delete() { files.delete(this.uri); }
    move(destination: MemoryFile) {
      if (failMove && this.uri === 'staging') { files.set(destination.uri, files.get(this.uri)!.slice(0, 2)); throw new Error('injected interrupted move'); }
      files.set(destination.uri, files.get(this.uri)!); files.delete(this.uri); this.uri = destination.uri;
    }
  }
  const bytes = Uint8Array.from([0, 255, 137, 80, 78, 71, 99]); const ref = { sha256: await sha256(bytes), size: bytes.length };
  const store = { destination: () => new MemoryFile('final'), staging: () => new MemoryFile('staging'), quarantine: () => new MemoryFile('corrupt-retained'), reopen: (uri: string) => new MemoryFile(uri) };
  await assert.rejects(installVerifiedBlob(ref, bytes, sha256, store), /interrupted move/);
  assert.deepEqual(files.get('final'), bytes.slice(0, 2)); assert.equal(files.has('staging'), false);
  failMove = false;
  assert.equal(await installVerifiedBlob(ref, bytes, sha256, store), 'final');
  assert.deepEqual(files.get('final'), bytes); assert.deepEqual(files.get('corrupt-retained'), bytes.slice(0, 2));
  assert.equal(files.has('staging'), false);
  await assert.rejects(installVerifiedBlob(ref, Uint8Array.from([1]), sha256, store), /校验失败/);
  assert.deepEqual(files.get('final'), bytes);
});
function wrap(raw: DatabaseSync) {
  const db = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (callback: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try { await callback(db as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return db as unknown as SQLiteDatabase;
}
async function database(deviceId: string, blank = false) {
  const raw = new DatabaseSync(':memory:'); const db = wrap(raw);
  await migrateDatabase(db);
  if (!raw.prepare("SELECT name FROM sqlite_master WHERE name='sync_settings'").get()) raw.exec(SYNC_MIGRATION_SQL);
  if (blank) {
    raw.exec('PRAGMA foreign_keys=OFF');
    for (const table of [...SYNC_TABLES].reverse()) raw.exec(`DELETE FROM ${table}`);
    raw.exec('DELETE FROM sync_changes; PRAGMA foreign_keys=ON');
  }
  await saveSyncConfiguration(db, { endpoint: 'https://sync.example.test/dav', libraryId: 'test-library', deviceId, consent: true });
  return { raw, db };
}
function assets() {
  const files = new Map<string, Uint8Array>();
  const store: SyncAssets = {
    async exportFile(uri, mediaType) {
      const bytes = files.get(uri); if (!bytes) throw new Error('missing original');
      const ref = { sha256: await sha256(bytes), size: bytes.length, mediaType }; files.set(ref.sha256, bytes); return ref;
    },
    async install(ref, bytes) {
      assert.equal(await sha256(bytes), ref.sha256); assert.equal(bytes.length, ref.size); files.set(ref.sha256, bytes); return `file:///private/${ref.sha256}`;
    },
    async localUri(ref) { if (!files.has(ref.sha256)) throw new Error('missing attachment'); return `file:///private/${ref.sha256}`; },
  };
  return { store, files, read: async (ref: BlobRef) => { const bytes = files.get(ref.sha256); if (!bytes) throw new Error('missing blob'); return bytes; } };
}
class MemoryTransport implements SyncTransport {
  files = new Map<string, Uint8Array>(); directories = new Set<string>();
  async ensureDirectories(paths: string[]) { paths.forEach((path) => this.directories.add(path)); }
  async list(path: string) {
    return [...this.directories].filter((item) => item !== path && item.startsWith(path) && !item.slice(path.length).replace(/\/$/, '').includes('/')).map((item) => ({ path: item, directory: true }))
      .concat([...this.files.keys()].filter((item) => item.startsWith(path) && !item.slice(path.length).includes('/')).map((item) => ({ path: item, directory: false })));
  }
  async read(path: string) { return this.files.get(path) ?? null; }
  async writeImmutable(path: string, bytes: Uint8Array) { if (this.files.has(path)) assert.deepEqual(this.files.get(path), bytes); this.files.set(path, bytes); }
}
async function sync(db: SQLiteDatabase, transport: MemoryTransport, storage = assets()) {
  const state = await captureLocalChanges(db, sha256, storage.store);
  return synchronize({ state, sha256, transport, readBlob: storage.read, apply: (app) => applySyncApplication(db, app, storage.store) });
}
function doc(id: string, projectId: string, body = '内容'): SyncEntity {
  return { id, kind: 'documents', boardId: projectId, data: { id, project_id: projectId, path: `${id}.md`, title: id, body, origin: 'learner', created_at: '2026-09-22', updated_at: '2026-09-22' } };
}

test('reading selection snapshots survive offline queue and a second SQLite device without a protocol change', async t => {
  const a = await database('selection-phone'); const b = await database('selection-peer', true);
  t.after(() => { a.raw.close(); b.raw.close(); });
  const board = await createFreeBoard(a.db, '选区同步', '# 来源\n\n中文原文。\n\n后文。');
  const document = (await listNodeDocuments(a.db, board.nodeId))[0];
  const digest = async (text: string) => createHash('sha256').update(text).digest('hex');
  const reference = await createReadingReference(document, 1, 1, digest);
  const chat = await createConversation(a.db, board.projectId, board.nodeId, '选区');
  const body = composeReadingQuestion(reference, '请解释');
  const turn = await beginConversationTurn(a.db, chat, body);
  await updateConversationReply(a.db, turn.assistantId, '合成回答', 'complete', 'synthetic');
  const transport = new MemoryTransport(); await sync(a.db, transport); await sync(b.db, transport); await sync(b.db, transport);
  const messages = await listMessages(b.db, chat); assert.equal(messages.length, 2); assert.equal(messages[0].body, body);
  const restored = await b.db.getFirstAsync<{ id: string; projectId: string; body: string }>('SELECT id,project_id AS projectId,body FROM documents WHERE id=?', document.id);
  assert.deepEqual(await resolveReadingReference(parseReadingQuestion(messages[0].body)!.reference, restored, digest), { status: 'exact', index: 1 });
});

test('migration tracks every content table and local queue/state commit rolls back as one unit', async () => {
  const { raw, db } = await database('phone'); const storage = assets();
  for (const table of SYNC_TABLES) assert.equal((raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE ?").get(`sync_track_${table}_%`) as { n: number }).n, 3);
  const initial = raw.prepare('SELECT count(*) AS n FROM sync_changes').get();
  await assert.rejects(captureLocalChanges(db, async () => { throw new Error('injected power loss'); }, storage.store), /power loss/);
  assert.deepEqual(raw.prepare('SELECT count(*) AS n FROM sync_changes').get(), initial);
  assert.equal((await loadSyncState(db))?.outbox.length, 0);
  const state = await captureLocalChanges(db, sha256, storage.store);
  assert.equal(state.outbox.length, 1);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n, 0);
  raw.close();
});

test('SQLite projections, queue acknowledgements and duplicate pull converge without echo triggers', async () => {
  const a = await database('phone'); const b = await database('desktop', true); const transport = new MemoryTransport();
  await sync(a.db, transport); await sync(b.db, transport); await sync(b.db, transport);
  assert.deepEqual(b.raw.prepare('SELECT id,title,body FROM documents ORDER BY id').all(), a.raw.prepare('SELECT id,title,body FROM documents ORDER BY id').all());
  assert.equal((b.raw.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n, 0);
  assert.equal((await loadSyncState(b.db))?.outbox.length, 0);
  assert.equal((await loadSyncState(b.db))?.nextSequence, 1);
  a.raw.close(); b.raw.close();
});

test('inbound cross-project references roll back documents, graph and cursor together', async () => {
  const { db, raw } = await database('phone'); const storage = assets(); const state = await captureLocalChanges(db, sha256, storage.store);
  const project: SyncEntity = { id: 'other', kind: 'projects', boardId: 'other', data: { id: 'other', title: 'other', created_at: 'now', updated_at: 'now' } };
  const node: SyncEntity = { id: 'bad-node', kind: 'nodes', boardId: 'other', data: { id: 'bad-node', project_id: 'other', title: 'bad', x: 0, y: 0, importance: 5, status: 'learning', document_id: 'doc-transformer' } };
  const incoming = await queueLocalChanges(createSyncState('test-library', 'remote'), [{ entity: project }, { entity: node }], sha256);
  await assert.rejects(applySyncApplication(db, { state: incoming, commit: incoming.commits['remote:1'].commit, entities: [project, node], conflicts: [], blobs: [] }, storage.store), /跨图谱/);
  assert.equal(raw.prepare("SELECT id FROM projects WHERE id='other'").get(), undefined);
  assert.deepEqual(await loadSyncState(db), state);
  assert.equal((raw.prepare('SELECT suppress FROM sync_control').get() as { suppress: number }).suppress, 0);
  raw.close();
});

test('offline Markdown conflicts retain both versions and explicit merged resolution converges', async () => {
  const a = await database('phone'); const b = await database('desktop', true); const t = new MemoryTransport();
  await sync(a.db, t); await sync(b.db, t);
  a.raw.exec("UPDATE documents SET body='手机离线理解' WHERE id='doc-transformer'");
  b.raw.exec("UPDATE documents SET body='桌面离线理解' WHERE id='doc-transformer'");
  await sync(a.db, t); await sync(b.db, t); await sync(a.db, t);
  const conflicts = await listSyncConflicts(a.db);
  assert.equal(conflicts.length, 1); assert.equal(conflicts[0].versions.length, 2);
  assert.equal((a.raw.prepare("SELECT body FROM documents WHERE id='doc-transformer'").get() as { body: string }).body, '手机离线理解');
  a.raw.exec("UPDATE documents SET body='继续完善手机理解' WHERE id='doc-transformer'");
  await sync(a.db, t); await sync(b.db, t);
  const editedConflicts = await listSyncConflicts(a.db);
  assert.equal(editedConflicts[0].versions.length, 2, 'ordinary editing must not silently resolve another device version');
  assert.ok(editedConflicts[0].versions.some((version) => version.entity.data?.body === '桌面离线理解'));
  assert.ok(editedConflicts[0].versions.some((version) => version.entity.data?.body === '继续完善手机理解'));
  await resolveSyncConflict(a.db, editedConflicts[0].key, editedConflicts[0].versions[0].revision, '合并：手机与桌面的理解', sha256, assets().store);
  await sync(a.db, t); await sync(b.db, t);
  assert.equal((b.raw.prepare("SELECT body FROM documents WHERE id='doc-transformer'").get() as { body: string }).body, '合并：手机与桌面的理解');
  assert.equal((await listSyncConflicts(a.db)).length, 0);
  assert.equal((a.raw.prepare('SELECT count(*) AS n FROM sync_conflicts WHERE resolved_at IS NOT NULL').get() as { n: number }).n, 1);
  a.raw.close(); b.raw.close();
});

test('original attachment bytes transfer by digest; no absolute source path enters any commit', async () => {
  const a = await database('phone'); const b = await database('desktop', true); const t = new MemoryTransport(); const aa = assets(); const bb = assets();
  aa.files.set('file:///private/original.pdf', Uint8Array.from([37, 80, 68, 70, 0, 255]));
  a.raw.exec(`INSERT INTO source_items(id,project_id,kind,title,media_type,asset_uri,content_hash,byte_size,extraction_status,derived_document_id,created_at,updated_at)
    VALUES('pdf','project-transformer','pdf','原始论文','application/pdf','file:///private/original.pdf','original-hash',6,'ready','doc-transformer','now','now')`);
  await sync(a.db, t, aa); await sync(b.db, t, bb);
  const serialized = JSON.stringify(await loadSyncState(a.db));
  assert.doesNotMatch(serialized, /file:\/|asset_uri/);
  const row = b.raw.prepare("SELECT asset_uri FROM source_items WHERE id='pdf'").get() as { asset_uri: string };
  assert.match(row.asset_uri, /^file:\/\/\/private\/[a-f0-9]{64}$/);
  const digest = row.asset_uri.split('/').pop()!;
  assert.deepEqual(bb.files.get(digest), aa.files.get('file:///private/original.pdf'));
  a.raw.close(); b.raw.close();
});

test('unknown fields survive an Android edit and unknown entity categories remain durable', async () => {
  const { raw, db } = await database('phone'); const storage = assets(); let state = await captureLocalChanges(db, sha256, storage.store);
  const known = { ...doc('doc-transformer', 'project-transformer'), data: { ...doc('doc-transformer', 'project-transformer').data, path: '目标/理解-transformer.md', _desktop: { color: 'blue' } } };
  const unknown: SyncEntity = { id: 'future', kind: 'future_learning_cards', boardId: 'project-transformer', data: { id: 'future', text: '保持原样' } };
  state = await queueLocalChanges(state, [{ entity: known }, { entity: unknown }], sha256);
  await applySyncApplication(db, { state, commit: state.commits[state.outbox.at(-1)!].commit, entities: [known, unknown], conflicts: [], blobs: [] }, storage.store);
  raw.exec("UPDATE documents SET body='安卓更新' WHERE id='doc-transformer'");
  const updated = await captureLocalChanges(db, sha256, storage.store);
  const last = updated.commits[updated.outbox.at(-1)!].commit.changes[0].entity;
  assert.deepEqual(last.data?._desktop, { color: 'blue' });
  assert.equal((raw.prepare("SELECT body FROM sync_projection WHERE kind='future_learning_cards'").get() as { body: string }).body, JSON.stringify(unknown.data));
  raw.close();
});

test('local edits during network activity never get overwritten by an inbound projection', async () => {
  const { raw, db } = await database('phone'); const storage = assets(); const before = await captureLocalChanges(db, sha256, storage.store);
  raw.exec("UPDATE documents SET body='just typed' WHERE id='doc-transformer'");
  const entity = doc('doc-transformer', 'project-transformer', 'remote');
  await assert.rejects(applySyncApplication(db, { state: before, commit: null, entities: [entity], conflicts: [], blobs: [] }, storage.store), /本地修改/);
  assert.equal((raw.prepare("SELECT body FROM documents WHERE id='doc-transformer'").get() as { body: string }).body, 'just typed');
  raw.close();
});

test('delete tombstones stay durable and replay without resurrection', async () => {
  const a = await database('phone'); const b = await database('desktop', true); const t = new MemoryTransport();
  await a.db.runAsync("INSERT INTO documents(id,project_id,path,title,body,origin,created_at,updated_at) VALUES('loose','project-transformer','loose.md','loose','内容','learner','now','now')");
  await sync(a.db, t); await sync(b.db, t);
  a.raw.exec("DELETE FROM documents WHERE id='loose'"); await sync(a.db, t); await sync(b.db, t); await sync(b.db, t);
  assert.equal(b.raw.prepare("SELECT id FROM documents WHERE id='loose'").get(), undefined);
  const state = await loadSyncState(b.db) as SyncState;
  const head = state.heads[entityKey({ kind: 'documents', id: 'loose' })][0];
  assert.equal(state.commits[head].commit.changes.find((c) => c.entity.id === 'loose')?.entity.data, null);
  assert.equal(getConflicts(state).length, 0);
  a.raw.close(); b.raw.close();
});

test('all 21 content categories including conversation provenance, learning and reading positions round-trip', async () => {
  const a = await database('phone'); const b = await database('desktop', true); const t = new MemoryTransport();
  a.raw.exec(`
    INSERT INTO topics VALUES('topic',NULL,'学习专题','now','now');
    UPDATE projects SET topic_id='topic' WHERE id='project-transformer';
    INSERT INTO prompt_templates VALUES('prompt','询问','为什么',0,'now','now');
    INSERT INTO ai_understanding_documents VALUES('understanding','global','global','preference','偏好','逐步理解',1,'now','now');
    INSERT INTO project_ai_scope_settings VALUES('project-transformer','global','global',1,'now');
    INSERT INTO node_answers(id,project_id,node_id,question,body,adapter,is_saved,created_at,updated_at) VALUES('answer','project-transformer','node-transformer','为何','回答','local',1,'now','now');
    INSERT INTO favorite_bindings VALUES('global','global','favorite-answer-answer','now');
    INSERT INTO source_items(id,project_id,kind,title,media_type,content_hash,extraction_status,derived_document_id,created_at,updated_at) VALUES('source','project-transformer','text','原始资料','text/plain','hash','ready','doc-transformer','now','now');
    INSERT INTO source_segments VALUES('segment','source',0,'paragraph','第一段','原文','hash');
    INSERT INTO source_citations VALUES('citation','project-transformer','node','node-transformer','source','第一段','原文','now');
    INSERT INTO mastery_attempts VALUES('mastery','project-transformer','node-transformer','解释','理解','重点','passed','now');
    INSERT INTO graph_mutation_batches VALUES('batch','project-transformer','node-transformer','old-job','answer','applied','[]','[]','[]','{}','now',NULL);
    INSERT INTO conversations VALUES('conversation','project-transformer','node-transformer','进一步理解','now','now');
    INSERT INTO conversation_messages VALUES('message','conversation','assistant','完整对话','complete',0,NULL,'local','now','now');
    INSERT INTO documents(id,project_id,path,title,body,origin,created_at,updated_at) VALUES('saved','project-transformer','saved.md','整理','对话存为文档','learner','now','now');
    INSERT INTO node_documents VALUES('extra-link','node-transformer','saved',1);
    INSERT INTO conversation_documents VALUES('provenance','conversation',NULL,'saved','node-transformer','["message"]','selection','now');
    INSERT INTO reading_positions VALUES('position','saved','heading',0.6,'now');
  `);
  await sync(a.db, t); await sync(b.db, t);
  for (const table of SYNC_TABLES) {
    const orderBy = table === 'project_ai_scope_settings' ? 'project_id,scope_type,scope_id' : table === 'favorite_bindings' ? 'scope_type,scope_id,favorite_id' : 'id';
    assert.deepEqual(b.raw.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all(), a.raw.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all(), table);
  }
  a.raw.close(); b.raw.close();
});

test('foreground/background workers share a durable lease and interrupted owners expire safely', async () => {
  const { db, raw } = await database('phone');
  assert.equal(await acquireSyncLease(db, 'foreground', 1000), true);
  assert.equal(await acquireSyncLease(db, 'background', 1100), false);
  await releaseSyncLease(db, 'not-owner');
  assert.equal(await acquireSyncLease(db, 'background', 1200), false);
  assert.equal(await acquireSyncLease(db, 'background', 181001), true);
  await releaseSyncLease(db, 'foreground');
  assert.equal((raw.prepare('SELECT lease_owner FROM sync_control').get() as { lease_owner: string }).lease_owner, 'background');
  await releaseSyncLease(db, 'background');
  assert.equal(await acquireSyncLease(db, 'foreground', 181002), true);
  raw.close();
});

test('parent deletion never cascades away retained children or advances the cursor', async () => {
  const { raw, db } = await database('phone'); const storage = assets(); const before = await captureLocalChanges(db, sha256, storage.store);
  const deletion: SyncEntity = { id: 'node-transformer', kind: 'nodes', boardId: 'project-transformer', data: null };
  const remote = await queueLocalChanges(before, [{ entity: deletion }], sha256);
  await assert.rejects(applySyncApplication(db, { state: remote, commit: remote.commits[remote.outbox.at(-1)!].commit, entities: [deletion], conflicts: [], blobs: [] }, storage.store), /仍保留的子资料/);
  assert.ok(raw.prepare("SELECT id FROM nodes WHERE id='node-transformer'").get());
  assert.deepEqual(await loadSyncState(db), before);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM sync_blocked_inbound').get() as { n: number }).n, 1);
  raw.close();
});

test('explicitly retaining local versions resolves concurrent board deletion and document edits on both devices', async () => {
  const a = await database('desktop'); const b = await database('phone', true); const t = new MemoryTransport();
  await sync(a.db, t); await sync(b.db, t);
  b.raw.exec("UPDATE documents SET body='离线写下的重要理解' WHERE id='doc-transformer'; INSERT INTO prompt_templates VALUES('unrelated','保留的模板','独立内容',0,'now','now');");
  a.raw.exec("BEGIN; DELETE FROM edges WHERE project_id='project-transformer'; DELETE FROM nodes WHERE project_id='project-transformer'; DELETE FROM documents WHERE project_id='project-transformer'; DELETE FROM projects WHERE id='project-transformer'; COMMIT;");
  await sync(a.db, t);
  await assert.rejects(sync(b.db, t), /仍保留的子资料/);
  const blocked = (await listBlockedSync(b.db)).find((record) => !record.resolved_at)!;
  assert.ok(blocked.localEntities.some((entity) => entity.data?.body === '离线写下的重要理解'));
  const before = await loadSyncState(b.db) as SyncState;
  await keepLocalBlockedSync(b.db, blocked.id, sha256);
  const resolved = await loadSyncState(b.db) as SyncState;
  const resolution = resolved.commits[resolved.outbox.at(-1)!].commit;
  assert.equal(resolution.changes.some((change) => change.entity.id === 'unrelated'), false);
  assert.equal(resolution.changes.length, blocked.commit.changes.length);
  assert.equal(Object.keys(resolved.commits).length, Object.keys(before.commits).length + 2);
  assert.ok(resolved.commits[blocked.id].commit.changes.every((change) => change.entity.data === null));
  assert.ok((await listBlockedSync(b.db))[0].resolved_at);
  assert.equal((await sync(b.db, t)).pending.length, 0);
  assert.equal((await sync(a.db, t)).pending.length, 0);
  await sync(b.db, t);
  assert.equal((a.raw.prepare("SELECT body FROM documents WHERE id='doc-transformer'").get() as { body: string }).body, '离线写下的重要理解');
  assert.deepEqual(a.raw.prepare('SELECT id,title FROM projects ORDER BY id').all(), b.raw.prepare('SELECT id,title FROM projects ORDER BY id').all());
  assert.equal((await listSyncConflicts(a.db)).length, 0); assert.equal((await listSyncConflicts(b.db)).length, 0);
  a.raw.close(); b.raw.close();
});

test('real Lumen adapter fixtures project to SQLite and Android edits retain desktop extension fields', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/lumen-desktop-initial.json', import.meta.url), 'utf8')) as { entities: SyncEntity[]; blobs: Record<string, number[]> };
  const edited = JSON.parse(readFileSync(new URL('./fixtures/lumen-desktop-edited.json', import.meta.url), 'utf8')) as typeof fixture;
  const { db, raw } = await database('android', true); const storage = assets();
  let state = await loadSyncState(db) as SyncState;
  for (const snapshot of [fixture, edited]) {
    const changes = snapshot.entities.map((entity) => ({ entity, blobs: entity.data?.asset_blob ? [entity.data.asset_blob as BlobRef] : [] }));
    state = await queueLocalChanges(state, changes, sha256);
    await applySyncApplication(db, { state, commit: state.commits[state.outbox.at(-1)!].commit, entities: snapshot.entities, conflicts: [], blobs: Object.entries(snapshot.blobs).map(([hash, bytes]) => ({ ref: { sha256: hash, size: bytes.length }, bytes: Uint8Array.from(bytes) })) }, storage.store);
  }
  assert.equal((raw.prepare('SELECT count(*) AS n FROM node_documents').get() as { n: number }).n, 3);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM conversation_messages').get() as { n: number }).n, 2);
  const document = edited.entities.find((entity) => entity.kind === 'documents' && entity.data?._lumen_path === 'docs/answer.md')!;
  raw.prepare('UPDATE documents SET body=? WHERE id=?').run('Android 新理解', document.id);
  const next = await captureLocalChanges(db, sha256, storage.store);
  const outgoing = next.commits[next.outbox.at(-1)!].commit.changes.find((change) => change.entity.id === document.id)!;
  assert.equal(outgoing.entity.data?._lumen_path, 'docs/answer.md');
  assert.equal(outgoing.entity.data?.body, 'Android 新理解');
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  // Optional synthetic interoperability artifact for the desktop adapter's inverse test.
  if (process.env.LUMEN_SYNTHETIC_FIXTURE_OUTPUT) {
    const entities = Object.entries(next.heads).map(([key, heads]) => next.commits[heads[0]].commit.changes.find((change) => entityKey(change.entity) === key)!.entity);
    const blobs = Object.fromEntries([...storage.files].filter(([key]) => /^[a-f0-9]{64}$/.test(key)).map(([key, value]) => [key, [...value]]));
    writeFileSync(process.env.LUMEN_SYNTHETIC_FIXTURE_OUTPUT, JSON.stringify({ entities, blobs }, null, 2));
  }
  raw.close();
});
