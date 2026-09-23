import { assertSync, canonicalJson, checkAbort, commitPath, entityKey, LIMITS, parseSignedCommit, SyncError, utf8Encode, validNamespace, validateBlob, validateCommit } from './codec';
import type { BlobRef, LocalChange, Sha256, SignedCommit, SyncChange, SyncCommit, SyncConflict, SyncOptions, SyncResult, SyncState } from './types';

export function createSyncState(libraryId: string, deviceId: string): SyncState {
  assertSync(validNamespace(libraryId) && validNamespace(deviceId), 'invalid-library-or-device');
  return { protocol: 1, libraryId, deviceId, nextSequence: 1, commits: {}, heads: {}, outbox: [] };
}
function changeAt(state: SyncState, revision: string, key: string): SyncChange | undefined { return state.commits[revision]?.commit.changes.find(c => entityKey(c.entity) === key); }
function dependencies(state: SyncState, c: SyncCommit): string[] {
  const missing = new Set<string>();
  if (c.previous && !state.commits[c.previous]) missing.add(c.previous);
  for (const change of c.changes) for (const parent of change.parents) {
    if (!state.commits[parent]) missing.add(parent);
    else assertSync(changeAt(state, parent, entityKey(change.entity)), 'parent-entity-mismatch');
  }
  return [...missing];
}
function ancestor(state: SyncState, key: string, older: string, newer: string): boolean {
  const stack = [newer]; const seen = new Set<string>();
  while (stack.length) {
    const revision = stack.pop()!;
    if (revision === older) return true;
    if (seen.has(revision)) continue;
    seen.add(revision);
    stack.push(...(changeAt(state, revision, key)?.parents ?? []));
  }
  return false;
}
function accept(state: SyncState, signed: SignedCommit): SyncState {
  assertSync(!state.commits[signed.commit.id], 'duplicate-commit');
  assertSync(Object.keys(state.commits).length < LIMITS.commits, 'history-limit');
  assertSync(dependencies(state, signed.commit).length === 0, 'missing-dependency');
  const next = { ...state, commits: { ...state.commits, [signed.commit.id]: signed }, heads: { ...state.heads } };
  for (const change of signed.commit.changes) {
    const key = entityKey(change.entity);
    const candidates = [...(state.heads[key] ?? []), signed.commit.id];
    next.heads[key] = candidates.filter(a => !candidates.some(b => a !== b && ancestor(next, key, a, b))).sort();
  }
  return next;
}
export function getConflicts(state: SyncState): SyncConflict[] {
  return Object.entries(state.heads).filter(([, heads]) => heads.length > 1).sort(([a], [b]) => a.localeCompare(b)).map(([key, heads]) => ({ key, versions: heads.map(revision => {
    const change = changeAt(state, revision, key);
    assertSync(change, 'invalid-state-head');
    return { revision, entity: change.entity, blobs: change.blobs };
  }) }));
}
/** Explicit conflict resolution uses the same call: the new revision references every current head. */
export async function queueLocalChanges(state: SyncState, changes: LocalChange[], sha256: Sha256): Promise<SyncState> {
  assertSync(state.protocol === 1, 'unsupported-protocol');
  const c: SyncCommit = {
    protocol: 1, libraryId: state.libraryId, deviceId: state.deviceId, sequence: state.nextSequence,
    id: `${state.deviceId}:${state.nextSequence}`, previous: state.nextSequence === 1 ? null : `${state.deviceId}:${state.nextSequence - 1}`,
    changes: changes.map(change => {
      const heads = state.heads[entityKey(change.entity)] ?? [];
      const parents = change.parents ?? heads;
      assertSync(Array.isArray(parents) && parents.every(parent => heads.includes(parent)), 'local-parent-not-current-head');
      return { entity: change.entity, blobs: change.blobs ?? [], parents: [...parents].sort() };
    }),
  };
  validateCommit(c, state.libraryId);
  // Round-trip isolates caller mutation and normalizes data into JSON-owned values.
  const canonical = canonicalJson(c);
  const signed: SignedCommit = { commit: JSON.parse(canonical) as SyncCommit, sha256: await sha256(utf8Encode(canonical)) };
  assertSync(/^[a-f0-9]{64}$/.test(signed.sha256), 'invalid-sha256-provider');
  assertSync(utf8Encode(canonicalJson(signed)).length <= LIMITS.commitBytes, 'commit-size-limit');
  const next = accept(state, signed);
  return { ...next, nextSequence: state.nextSequence + 1, outbox: [...state.outbox, c.id] };
}
/** Validates persisted state, including hashes, DAG dependencies and recomputed heads. */
export async function parseSyncState(serialized: string, sha256: Sha256): Promise<SyncState> {
  assertSync(serialized.length <= 128 * 1024 * 1024, 'state-size-limit');
  let state: SyncState;
  try { state = JSON.parse(serialized) as SyncState; } catch { throw new SyncError('invalid-state-json'); }
  assertSync(state && state.protocol === 1 && state.commits && typeof state.commits === 'object' && state.heads && typeof state.heads === 'object', 'invalid-state');
  let rebuilt = createSyncState(state.libraryId, state.deviceId);
  const records = Object.entries(state.commits);
  assertSync(records.length <= LIMITS.commits, 'history-limit');
  for (const [id, signed] of records) {
    const checked = parseSignedCommit(utf8Encode(canonicalJson(signed)), state.libraryId);
    assertSync(id === checked.commit.id && checked.sha256 === await sha256(utf8Encode(canonicalJson(checked.commit))), 'state-hash-mismatch');
  }
  let pending = records.map(([, signed]) => signed);
  while (pending.length) {
    const waiting: SignedCommit[] = [];
    for (const signed of pending) { if (dependencies(rebuilt, signed.commit).length) waiting.push(signed); else rebuilt = accept(rebuilt, signed); }
    assertSync(waiting.length < pending.length, 'state-missing-dependency'); pending = waiting;
  }
  assertSync(canonicalJson(rebuilt.heads) === canonicalJson(state.heads), 'state-head-mismatch');
  const local = records.filter(([, s]) => s.commit.deviceId === state.deviceId).map(([, s]) => s.commit.sequence);
  assertSync(Number.isSafeInteger(state.nextSequence) && state.nextSequence === (local.length ? Math.max(...local) + 1 : 1), 'state-sequence-mismatch');
  assertSync(Array.isArray(state.outbox) && new Set(state.outbox).size === state.outbox.length, 'invalid-outbox');
  for (const id of state.outbox) assertSync(typeof id === 'string' && state.commits[id]?.commit.deviceId === state.deviceId, 'invalid-outbox');
  return { ...rebuilt, nextSequence: state.nextSequence, outbox: [...state.outbox] };
}
async function verifyBlob(ref: BlobRef, bytes: Uint8Array, sha256: Sha256) {
  validateBlob(ref);
  assertSync(bytes.length === ref.size && await sha256(bytes) === ref.sha256, 'blob-integrity');
}
function uniqueBlobs(commit: SyncCommit): BlobRef[] {
  const refs = new Map<string, BlobRef>();
  for (const change of commit.changes) for (const ref of change.blobs) {
    assertSync(!refs.has(ref.sha256) || refs.get(ref.sha256)!.size === ref.size, 'blob-reference-mismatch'); refs.set(ref.sha256, ref);
  }
  return [...refs.values()];
}
export async function synchronize(options: SyncOptions): Promise<SyncResult> {
  const { transport, sha256, apply, signal } = options;
  let state = options.state; let pulled = 0; let pushed = 0;
  assertSync(state.protocol === 1 && validNamespace(state.libraryId) && validNamespace(state.deviceId), 'invalid-state');
  const root = `lumen-sync-v1/${state.libraryId}/`;
  checkAbort(signal);
  await transport.ensureDirectories(['lumen-sync-v1/', root, `${root}commits/`, `${root}blobs/`, `${root}commits/${state.deviceId}/`], signal);
  // Publishing our durable outbox first preserves local concurrent revisions before pull projection.
  for (const id of [...state.outbox]) {
    checkAbort(signal);
    const signed = state.commits[id]; assertSync(signed, 'outbox-commit-missing');
    for (const ref of uniqueBlobs(signed.commit)) {
      const path = `${root}blobs/${ref.sha256}`;
      let bytes = await transport.read(path, ref.size, signal);
      if (bytes === null) {
        assertSync(options.readBlob, 'local-blob-reader-missing'); bytes = await options.readBlob(ref);
        await verifyBlob(ref, bytes, sha256); await transport.writeImmutable(path, bytes, signal);
        bytes = await transport.read(path, ref.size, signal);
        assertSync(bytes, 'uploaded-blob-missing');
      }
      await verifyBlob(ref, bytes, sha256);
    }
    checkAbort(signal);
    const path = commitPath(root, signed.commit); const bytes = utf8Encode(canonicalJson(signed));
    await transport.writeImmutable(path, bytes, signal);
    const confirmed = await transport.read(path, LIMITS.commitBytes, signal);
    assertSync(confirmed && canonicalJson(parseSignedCommit(confirmed, state.libraryId)) === canonicalJson(signed), 'commit-publication-mismatch');
    const next = { ...state, outbox: state.outbox.filter(item => item !== id) };
    checkAbort(signal);
    await apply({ state: next, commit: null, entities: [], conflicts: getConflicts(next), blobs: [] });
    state = next; pushed++;
  }
  const devices = await transport.list(`${root}commits/`, signal);
  assertSync(devices.length <= 1000, 'device-count-limit');
  const discovered = new Map<string, SignedCommit>();
  let listedFiles = 0;
  for (const device of devices) {
    checkAbort(signal);
    if (device.path === `${root}commits/`) continue;
    const name = device.path.slice(`${root}commits/`.length).replace(/\/$/, '');
    assertSync(device.directory && device.path.startsWith(`${root}commits/`) && validNamespace(name), 'invalid-device-path');
    const entries = await transport.list(`${root}commits/${name}/`, signal);
    assertSync(entries.length <= LIMITS.commits, 'history-limit');
    for (const entry of entries) {
      if (entry.path === `${root}commits/${name}/`) continue;
      assertSync(++listedFiles <= LIMITS.commits, 'history-limit');
      assertSync(!entry.directory && entry.path.startsWith(`${root}commits/${name}/`) && /^[0-9]{16}\.json$/.test(entry.path.slice(`${root}commits/${name}/`.length)), 'invalid-commit-path');
      const sequence = Number(entry.path.slice(-21, -5));
      const id = `${name}:${sequence}`;
      if (state.commits[id]) continue;
      const bytes = await transport.read(entry.path, LIMITS.commitBytes, signal);
      if (bytes === null) continue; // A partial/stale directory listing never advances any cursor.
      const signed = parseSignedCommit(bytes, state.libraryId);
      assertSync(commitPath(root, signed.commit) === entry.path && signed.sha256 === await sha256(utf8Encode(canonicalJson(signed.commit))), 'commit-integrity');
      assertSync(signed.commit.deviceId !== state.deviceId, 'device-identity-reused');
      discovered.set(signed.commit.id, signed);
      assertSync(discovered.size + Object.keys(state.commits).length <= LIMITS.commits, 'history-limit');
    }
  }
  let pending = [...discovered.values()].sort((a, b) => a.commit.id.localeCompare(b.commit.id));
  let progress = true;
  while (pending.length && progress) {
    progress = false; const waiting: SignedCommit[] = [];
    for (const signed of pending) {
      checkAbort(signal);
      if (dependencies(state, signed.commit).length) { waiting.push(signed); continue; }
      const blobs: { ref: BlobRef; bytes: Uint8Array }[] = []; let missingBlob = false;
      for (const ref of uniqueBlobs(signed.commit)) {
        const bytes = await transport.read(`${root}blobs/${ref.sha256}`, ref.size, signal);
        if (bytes === null) { missingBlob = true; break; }
        await verifyBlob(ref, bytes, sha256); blobs.push({ ref, bytes });
      }
      if (missingBlob) { waiting.push(signed); continue; }
      const next = accept(state, signed);
      const entities = signed.commit.changes.filter(change => next.heads[entityKey(change.entity)].length === 1 && next.heads[entityKey(change.entity)][0] === signed.commit.id).map(change => change.entity);
      checkAbort(signal);
      await apply({ state: next, commit: signed.commit, entities, conflicts: getConflicts(next), blobs });
      state = next; pulled++; progress = true;
    }
    pending = waiting;
  }
  return { state, pulled, pushed, pending: pending.map(s => s.commit.id) };
}
