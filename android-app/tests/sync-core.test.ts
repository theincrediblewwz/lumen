import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  canonicalJson, createSyncState, createWebDavTransport, entityKey, getConflicts, parseSyncState,
  parseWebDavListing, queueLocalChanges, synchronize, utf8Decode, utf8Encode, validateWebDavEndpoint,
  type BlobRef, type LocalChange, type SignedCommit, type SyncApplication, type SyncEntity,
  type SyncState, type SyncTransport,
} from '../sync/core';

const hash = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const doc = (id: string, body: string | null): SyncEntity => ({ id, kind: 'documents', boardId: 'board', data: body === null ? null : { id, body, title: '你好 🌍' } });
const root = 'lumen-sync-v1/library/';
class MemoryDav implements SyncTransport {
  files = new Map<string, Uint8Array>(); directories = new Set<string>();
  async ensureDirectories(paths: string[]) { paths.forEach(path => this.directories.add(path)); }
  async list(path: string) { return [...[...this.directories].filter(p => p.startsWith(path) && p !== path && !p.slice(path.length).replace(/\/$/, '').includes('/')).map(p => ({ path: p, directory: true })), ...[...this.files.keys()].filter(p => p.startsWith(path) && !p.slice(path.length).includes('/')).map(p => ({ path: p, directory: false }))].reverse(); }
  async read(path: string, maxBytes: number) { const value = this.files.get(path); if (!value) return null; assert.ok(value.length <= maxBytes); return value.slice(); }
  async writeImmutable(path: string, bytes: Uint8Array) { const old = this.files.get(path); if (old) assert.deepEqual(old, bytes); else this.files.set(path, bytes.slice()); }
}
async function queue(state: SyncState, ...entities: SyncEntity[]) { return queueLocalChanges(state, entities.map(entity => ({ entity })), hash); }
async function sync(state: SyncState, transport: SyncTransport, applications: SyncApplication[] = [], extra: Partial<Parameters<typeof synchronize>[0]> = {}) {
  return synchronize({ state, transport, sha256: hash, apply: async app => { applications.push(app); }, ...extra });
}
async function putCommit(dav: MemoryDav, signed: SignedCommit) {
  signed.sha256 = await hash(utf8Encode(canonicalJson(signed.commit)));
  await dav.ensureDirectories([`${root}commits/${signed.commit.deviceId}/`]);
  await dav.writeImmutable(`${root}commits/${signed.commit.deviceId}/${String(signed.commit.sequence).padStart(16, '0')}.json`, utf8Encode(canonicalJson(signed)));
}

test('three replicas merge independent objects, persist/restart, and replay without duplicates', async () => {
  const dav = new MemoryDav();
  let a = await queue(createSyncState('library', 'a'), doc('first', '# 中文\n\n🌍'));
  let b = await queue(createSyncState('library', 'b'), doc('second', 'offline B'));
  a = (await sync(a, dav)).state; b = (await sync(b, dav)).state;
  a = (await sync(a, dav)).state;
  const apps: SyncApplication[] = [];
  const c = (await sync(createSyncState('library', 'c'), dav, apps)).state;
  assert.deepEqual(c.heads, a.heads); assert.deepEqual(a.heads, b.heads);
  assert.equal(apps.flatMap(app => app.entities).length, 2);
  assert.deepEqual(await parseSyncState(JSON.stringify(c), hash), c);
  assert.equal((await sync(c, dav)).pulled, 0);
});

test('concurrent same-document content and deletion are retained; explicit resolution references all heads', async () => {
  const dav = new MemoryDav();
  let a = (await sync(await queue(createSyncState('library', 'a'), doc('d', 'original')), dav)).state;
  let b = (await sync(createSyncState('library', 'b'), dav)).state;
  a = await queue(a, doc('d', null)); b = await queue(b, doc('d', 'edited offline'));
  a = (await sync(a, dav)).state;
  const apps: SyncApplication[] = []; b = (await sync(b, dav, apps)).state;
  const conflict = getConflicts(b)[0]; assert.equal(conflict.versions.length, 2);
  assert.deepEqual(conflict.versions.map(v => v.entity.data?.body ?? null).sort(), ['edited offline', null].sort());
  assert.equal(apps.find(app => app.commit?.id === 'a:2')!.entities.length, 0);
  b = await queue(b, doc('d', 'chosen merged body'));
  assert.deepEqual(b.commits['b:2'].commit.changes[0].parents, ['a:2', 'b:1']);
  b = (await sync(b, dav)).state; a = (await sync(a, dav)).state;
  assert.deepEqual(a.heads, b.heads); assert.equal(getConflicts(a).length, 0);
  assert.equal(a.commits['b:1'].commit.changes[0].entity.data!.body, 'edited offline');
});

test('lost upload acknowledgement retries exact immutable identity and never duplicates domain rows', async () => {
  const dav = new MemoryDav(); const state = await queue(createSyncState('library', 'a'), doc('d', 'body'));
  const original = dav.writeImmutable.bind(dav); let lost = true;
  dav.writeImmutable = async (path, bytes) => { await original(path, bytes); if (lost && path.endsWith('.json')) { lost = false; throw new Error('lost acknowledgement'); } };
  await assert.rejects(sync(state, dav), /lost acknowledgement/);
  assert.deepEqual(state.outbox, ['a:1']);
  const result = await sync(state, dav); assert.equal(result.pushed, 1); assert.deepEqual(result.state.outbox, []);
  const apps: SyncApplication[] = []; await sync(createSyncState('library', 'b'), dav, apps);
  assert.equal(apps.flatMap(app => app.entities).length, 1); assert.equal(dav.files.size, 1);
});

test('projection or acknowledgement persistence failure does not advance caller state', async () => {
  const dav = new MemoryDav(); const a = await queue(createSyncState('library', 'a'), doc('d', 'body'));
  await assert.rejects(sync(a, dav, [], { apply: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(a.outbox.length, 1);
  const b = createSyncState('library', 'b');
  await assert.rejects(sync(b, dav, [], { apply: async () => { throw new Error('rollback'); } }), /rollback/);
  assert.equal(Object.keys(b.commits).length, 0);
  const result = await sync(b, dav); assert.equal(result.pulled, 1);
});

test('ordinary edit of displayed conflict head preserves other versions until explicit resolution', async () => {
  const dav = new MemoryDav();
  let a = await queue(createSyncState('library', 'a'), doc('d', 'A version'));
  let b = await queue(createSyncState('library', 'b'), doc('d', 'B version'));
  a = (await sync(a, dav)).state; b = (await sync(b, dav)).state;
  assert.equal(getConflicts(b).length, 1);
  b = await queueLocalChanges(b, [{ entity: doc('d', 'B edited again'), parents: ['b:1'] }], hash);
  assert.deepEqual(b.heads[entityKey(doc('d', ''))], ['a:1', 'b:2']);
  assert.deepEqual(getConflicts(b)[0].versions.map(version => version.entity.data!.body), ['A version', 'B edited again']);
  b = (await sync(b, dav)).state; a = (await sync(a, dav)).state;
  assert.deepEqual(a.heads, b.heads);
  await assert.rejects(queueLocalChanges(b, [{ entity: doc('d', 'invalid'), parents: ['b:1'] }], hash), /local-parent-not-current-head/);
  b = await queueLocalChanges(b, [{ entity: doc('d', 'unmatched projection'), parents: [] }], hash);
  assert.equal(getConflicts(b)[0].versions.length, 3);
  b = await queueLocalChanges(b, [{ entity: doc('d', 'explicit merged decision') }], hash);
  assert.equal(getConflicts(b).length, 0);
});

test('missing sequence or parent is held pending, then unordered listing recovers all', async () => {
  const dav = new MemoryDav(); let a = await queue(createSyncState('library', 'a'), doc('one', 'one'));
  a = await queue(a, doc('two', 'two')); await sync(a, dav);
  const firstPath = `${root}commits/a/0000000000000001.json`; const first = dav.files.get(firstPath)!; dav.files.delete(firstPath);
  const b = createSyncState('library', 'b'); const waiting = await sync(b, dav);
  assert.deepEqual(waiting.pending, ['a:2']); assert.equal(waiting.pulled, 0);
  dav.files.set(firstPath, first); const recovered = await sync(waiting.state, dav);
  assert.equal(recovered.pulled, 2); assert.deepEqual(recovered.pending, []);
});

test('parent revision must belong to the same entity', async () => {
  const dav = new MemoryDav(); let a = await queue(createSyncState('library', 'a'), doc('one', 'one'));
  a = await queue(a, doc('two', 'two'));
  const second = JSON.parse(JSON.stringify(a.commits['a:2'])) as SignedCommit;
  second.commit.changes[0].parents = ['a:1'];
  await putCommit(dav, a.commits['a:1']); await putCommit(dav, second);
  await assert.rejects(sync(createSyncState('library', 'b'), dav), /parent-entity-mismatch/);
});

test('verified content-addressed blobs precede commit publication and are delivered before apply', async () => {
  const dav = new MemoryDav(); const bytes = utf8Encode('原始附件 📝');
  const ref: BlobRef = { sha256: await hash(bytes), size: bytes.length, mediaType: 'text/plain' };
  const state = await queueLocalChanges(createSyncState('library', 'a'), [{ entity: doc('d', 'attachment'), blobs: [ref] }], hash);
  const original = dav.writeImmutable.bind(dav); let failed = true;
  dav.writeImmutable = async (path, data) => { if (failed && path.includes('/blobs/')) { failed = false; throw new Error('offline'); } await original(path, data); };
  await assert.rejects(sync(state, dav, [], { readBlob: async () => bytes }), /offline/);
  assert.equal([...dav.files.keys()].some(path => path.endsWith('.json')), false);
  await sync(state, dav, [], { readBlob: async () => bytes });
  const apps: SyncApplication[] = []; await sync(createSyncState('library', 'b'), dav, apps);
  assert.deepEqual(apps[0].blobs[0].bytes, bytes);
});

test('missing and corrupt remote blobs never apply half a commit', async () => {
  const dav = new MemoryDav(); const bytes = utf8Encode('original'); const ref = { sha256: await hash(bytes), size: bytes.length };
  const a = await queueLocalChanges(createSyncState('library', 'a'), [{ entity: doc('d', 'body'), blobs: [ref] }], hash);
  await putCommit(dav, a.commits['a:1']); const b = createSyncState('library', 'b');
  const result = await sync(b, dav); assert.equal(result.pulled, 0); assert.deepEqual(result.pending, ['a:1']);
  dav.files.set(`${root}blobs/${ref.sha256}`, utf8Encode('tampered'));
  await assert.rejects(sync(b, dav), /blob-integrity/); assert.equal(Object.keys(b.commits).length, 0);
});

test('malformed protocol, hashes, duplicate entities, secret fields and unsafe IDs fail closed', async () => {
  const a = createSyncState('library', 'a');
  await assert.rejects(queue(a, doc('d', 'one'), doc('d', 'two')), /duplicate-entity/);
  await assert.rejects(queue(a, { ...doc('d', 'body'), data: { id: 'd', api_key: 'fixture-secret' } }), /credential-field/);
  assert.throws(() => createSyncState('../outside', 'a'), /invalid-library/);
  const good = await queue(a, doc('d', 'body')); const serialized = JSON.stringify(good).replace('"body":"body"', '"body":"wrong"');
  await assert.rejects(parseSyncState(serialized, hash), /state-hash-mismatch/);
  const dav = new MemoryDav(); const bad = JSON.parse(JSON.stringify(good.commits['a:1'])); bad.commit.protocol = 2;
  await putCommit(dav, bad); await assert.rejects(sync(createSyncState('library', 'b'), dav), /unsupported-protocol/);
});

test('composite IDs and Unicode are payloads only; namespace and paths remain bounded', async () => {
  const composite = JSON.stringify(['项目/一', '节点:🌍']);
  const entity: SyncEntity = { id: composite, kind: 'node_topics', boardId: null, data: { node_id: '项目/一', topic_id: '节点:🌍' } };
  const state = await queue(createSyncState('library', 'a'), entity);
  assert.ok(state.heads[entityKey(entity)]); assert.deepEqual(await parseSyncState(JSON.stringify(state), hash), state);
  assert.equal(utf8Decode(utf8Encode('A中🌍')), 'A中🌍');
  assert.throws(() => utf8Decode(Uint8Array.from([0xc0, 0xaf])), /invalid-utf8/);
});

test('HTTPS endpoint validation permits user-owned NAS but rejects credentials, query and nonlocal HTTP', () => {
  assert.equal(validateWebDavEndpoint('https://nas.example:8443/remote.php/dav/files/u'), 'https://nas.example:8443/remote.php/dav/files/u/');
  for (const url of ['http://nas.example/dav', 'https://u:password@nas.example/dav', 'https://nas.example/?token=x', 'https://nas.example/#x']) assert.throws(() => validateWebDavEndpoint(url));
  assert.equal(validateWebDavEndpoint('http://127.0.0.1:9999/dav', true), 'http://127.0.0.1:9999/dav/');
  assert.throws(() => validateWebDavEndpoint('http://nas.example/dav', true), /https-required/);
});

const xml = (href: string, collection = false) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
test('DAV XML parsing rejects external entities, namespace escape and unexpected depth', () => {
  assert.deepEqual(parseWebDavListing(xml('/dav/commits/a/', true), 'https://server.example/dav/', 'commits/'), [{ path: 'commits/a/', directory: true }]);
  for (const text of [xml('https://evil.example/dav/commits/a/'), xml('/dav/commits/../../private'), xml('/dav/commits/a/deep'), '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///private">]>' + xml('&a;')]) assert.throws(() => parseWebDavListing(text, 'https://server.example/dav/', 'commits/'));
});

test('network errors redact credentials, redirects are rejected, and timeout/cancellation are bounded', async () => {
  const options = { endpoint: 'https://server.example/dav/', authorization: 'Basic synthetic-secret' };
  const broken = createWebDavTransport({ ...options, fetch: async () => { throw new Error('Basic synthetic-secret'); } });
  await assert.rejects(broken.read('safe', 100), error => error instanceof Error && error.message === 'Sync: network-failed');
  const redirected = createWebDavTransport({ ...options, fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }) });
  await assert.rejects(redirected.read('safe', 100), /redirect-rejected/);
  const hanging = createWebDavTransport({ ...options, timeoutMs: 15, fetch: async () => new Promise(() => {}) });
  await assert.rejects(hanging.read('safe', 100), /network-timeout/);
  const controller = new AbortController(); const pending = hanging.read('safe', 100, controller.signal); controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('streamed responses stop at byte limit and cannot bypass Content-Length checks', async () => {
  const transport = createWebDavTransport({ endpoint: 'https://server.example/', fetch: async () => new Response(new Uint8Array(32)) });
  await assert.rejects(transport.read('safe', 4), /response-size-limit/);
});

test('real loopback HTTP DAV fixture exchanges binary, Markdown, conflicts and immutable retries', async t => {
  const dav = new MemoryDav(); let putCount = 0; let conditionalCount = 0;
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').slice('/dav/'.length));
    if (req.headers.authorization !== 'Basic synthetic-fixture-only') { res.writeHead(401).end(); return; }
    if (req.method === 'MKCOL') { const exists = dav.directories.has(path); dav.directories.add(path); res.writeHead(exists ? 405 : 201).end(); return; }
    if (req.method === 'GET') { const bytes = dav.files.get(path); if (!bytes) { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes); return; }
    if (req.method === 'PUT') {
      putCount++; if (req.headers['if-none-match'] === '*') conditionalCount++;
      if (dav.files.has(path)) { res.writeHead(412).end(); return; }
      const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
      dav.files.set(path, Uint8Array.from(Buffer.concat(parts))); res.writeHead(201).end(); return;
    }
    if (req.method === 'PROPFIND') {
      assert.equal(req.headers.depth, '1'); const entries = await dav.list(path);
      const body = `<d:multistatus xmlns:d="DAV:">${entries.map(entry => `<d:response><d:href>/dav/${entry.path}</d:href><d:propstat><d:prop><d:resourcetype>${entry.directory ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(body); return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = createWebDavTransport({ endpoint: `http://127.0.0.1:${address.port}/dav/`, fetch, authorization: 'Basic synthetic-fixture-only', allowLocalHttpForTests: true });
  const blob = Uint8Array.from([0, 255, 1, 2, 128]); const ref = { sha256: await hash(blob), size: blob.length };
  const changes: LocalChange[] = [{ entity: doc('d', '# conversation\n\nuser: 为什么？\n\nassistant: 答案。'), blobs: [ref] }];
  let a = await queueLocalChanges(createSyncState('library', 'a'), changes, hash);
  a = (await sync(a, transport, [], { readBlob: async () => blob })).state;
  const apps: SyncApplication[] = []; let b = (await sync(createSyncState('library', 'b'), transport, apps)).state;
  assert.deepEqual(apps[0].blobs[0].bytes, blob);
  a = await queue(a, doc('d', 'Windows edit')); b = await queue(b, doc('d', 'Android edit'));
  await sync(a, transport); b = (await sync(b, transport)).state; assert.equal(getConflicts(b).length, 1);
  await sync(b, transport); assert.equal(putCount, 4); assert.equal(putCount, conditionalCount);
  await assert.rejects(transport.writeImmutable(`${root}blobs/${ref.sha256}`, Uint8Array.from([9, 9, 9, 9, 9])), /immutable-object-collision/);
});
