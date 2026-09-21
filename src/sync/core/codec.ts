import type { BlobRef, SignedCommit, SyncCommit, SyncEntity } from './types';

export const LIMITS = { commitBytes: 4 * 1024 * 1024, blobBytes: 32 * 1024 * 1024, totalBlobBytes: 128 * 1024 * 1024, changes: 5000, blobs: 1000, commits: 50000, listingBytes: 8 * 1024 * 1024, idLength: 512 } as const;
export class SyncError extends Error {
  constructor(public readonly code: string) { super(`Sync: ${code}`); this.name = 'SyncError'; }
}
export function assertSync(condition: unknown, code: string): asserts condition { if (!condition) throw new SyncError(code); }
export function checkAbort(signal?: AbortSignal) { assertSync(!signal?.aborted, 'cancelled'); }
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    let n = char.codePointAt(0)!;
    if (n >= 0xd800 && n <= 0xdfff) n = 0xfffd;
    if (n < 128) bytes.push(n);
    else if (n < 2048) bytes.push(192 | (n >> 6), 128 | (n & 63));
    else if (n < 65536) bytes.push(224 | (n >> 12), 128 | ((n >> 6) & 63), 128 | (n & 63));
    else bytes.push(240 | (n >> 18), 128 | ((n >> 12) & 63), 128 | ((n >> 6) & 63), 128 | (n & 63));
  }
  return Uint8Array.from(bytes);
}
export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let count = 0; let code = first;
    if (first >= 0xc2 && first <= 0xdf) { count = 1; code = first & 31; }
    else if (first >= 0xe0 && first <= 0xef) { count = 2; code = first & 15; }
    else if (first >= 0xf0 && first <= 0xf4) { count = 3; code = first & 7; }
    else assertSync(first < 128, 'invalid-utf8');
    assertSync(i + count <= bytes.length, 'invalid-utf8');
    for (let j = 0; j < count; j++) { const c = bytes[i++]; assertSync((c & 192) === 128, 'invalid-utf8'); code = (code << 6) | (c & 63); }
    assertSync((count !== 1 || code >= 128) && (count !== 2 || code >= 2048) && (count !== 3 || code >= 65536) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'invalid-utf8');
    parts.push(String.fromCodePoint(code));
  }
  return parts.join('');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function entityKey(entity: Pick<SyncEntity, 'kind' | 'id'>): string { return JSON.stringify([entity.kind, entity.id]); }
export function validNamespace(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.idLength && !/[\u0000-\u001f]/.test(value); }
export function validateJson(value: unknown, depth = 0, budget = { remaining: 100000 }) {
  assertSync(depth <= 32 && --budget.remaining >= 0, 'payload-complexity-limit');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { assertSync(value.length <= LIMITS.commitBytes, 'payload-string-limit'); return; }
  if (typeof value === 'number') { assertSync(Number.isFinite(value), 'invalid-number'); return; }
  assertSync(typeof value === 'object', 'invalid-json-value');
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1, budget); return; }
  assertSync(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'invalid-object');
  for (const [key, item] of Object.entries(value)) {
    assertSync(!['__proto__', 'constructor', 'prototype'].includes(key), 'unsafe-field');
    assertSync(!/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|authorization|secret|private[-_]?key|credentials)$/i.test(key), 'credential-field');
    validateJson(item, depth + 1, budget);
  }
}
export function validateEntity(value: unknown): asserts value is SyncEntity {
  assertSync(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-entity');
  const e = value as SyncEntity;
  assertSync(validId(e.id) && typeof e.kind === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.kind), 'invalid-entity-identity');
  assertSync(e.boardId === null || validId(e.boardId), 'invalid-board-identity');
  assertSync(e.data === null || (typeof e.data === 'object' && !Array.isArray(e.data)), 'invalid-entity-data');
  if (e.data !== null) {
    validateJson(e.data);
    assertSync(e.data.id === undefined || e.data.id === e.id, 'entity-id-mismatch');
  }
  assertSync(Object.keys(e).every(key => ['id', 'kind', 'boardId', 'data'].includes(key)), 'unknown-entity-field');
}
export function validateBlob(value: unknown): asserts value is BlobRef {
  assertSync(value !== null && typeof value === 'object', 'invalid-blob');
  const b = value as BlobRef;
  assertSync(typeof b.sha256 === 'string' && /^[a-f0-9]{64}$/.test(b.sha256), 'invalid-blob-hash');
  assertSync(Number.isSafeInteger(b.size) && b.size >= 0 && b.size <= LIMITS.blobBytes, 'blob-size-limit');
  assertSync(b.mediaType === undefined || (typeof b.mediaType === 'string' && b.mediaType.length <= 128 && !/[\r\n]/.test(b.mediaType)), 'invalid-media-type');
  assertSync(Object.keys(b).every(key => ['sha256', 'size', 'mediaType'].includes(key)), 'unknown-blob-field');
}
export function validateCommit(value: unknown, libraryId: string): asserts value is SyncCommit {
  assertSync(value !== null && typeof value === 'object', 'invalid-commit');
  const c = value as SyncCommit;
  assertSync(c.protocol === 1, 'unsupported-protocol');
  assertSync(c.libraryId === libraryId && validNamespace(c.libraryId) && validNamespace(c.deviceId), 'invalid-library-or-device');
  assertSync(Number.isSafeInteger(c.sequence) && c.sequence >= 1, 'invalid-sequence');
  assertSync(c.id === `${c.deviceId}:${c.sequence}` && c.previous === (c.sequence === 1 ? null : `${c.deviceId}:${c.sequence - 1}`), 'invalid-commit-identity');
  assertSync(Array.isArray(c.changes) && c.changes.length > 0 && c.changes.length <= LIMITS.changes, 'change-count-limit');
  const keys = new Set<string>(); const blobs = new Map<string, number>();
  for (const change of c.changes) {
    assertSync(change !== null && typeof change === 'object', 'invalid-change');
    validateEntity(change.entity);
    const key = entityKey(change.entity);
    assertSync(!keys.has(key), 'duplicate-entity'); keys.add(key);
    assertSync(Array.isArray(change.parents) && change.parents.length <= 1000 && new Set(change.parents).size === change.parents.length, 'invalid-parents');
    for (const p of change.parents) assertSync(typeof p === 'string' && /^[A-Za-z0-9_-]{1,96}:[1-9][0-9]{0,15}$/.test(p) && p !== c.id, 'invalid-parent-identity');
    assertSync(Array.isArray(change.blobs) && change.blobs.length <= LIMITS.blobs, 'blob-count-limit');
    change.blobs.forEach(validateBlob);
    for (const blob of change.blobs) {
      assertSync(!blobs.has(blob.sha256) || blobs.get(blob.sha256) === blob.size, 'blob-reference-mismatch');
      blobs.set(blob.sha256, blob.size);
    }
    assertSync(Object.keys(change).every(key => ['entity', 'parents', 'blobs'].includes(key)), 'unknown-change-field');
  }
  assertSync(blobs.size <= LIMITS.blobs && [...blobs.values()].reduce((sum, size) => sum + size, 0) <= LIMITS.totalBlobBytes, 'commit-blob-budget');
  assertSync(Object.keys(c).every(key => ['protocol', 'libraryId', 'deviceId', 'sequence', 'id', 'previous', 'changes'].includes(key)), 'unknown-commit-field');
}
export function parseSignedCommit(bytes: Uint8Array, libraryId: string): SignedCommit {
  assertSync(bytes.length <= LIMITS.commitBytes, 'commit-size-limit');
  let value: SignedCommit;
  try { value = JSON.parse(utf8Decode(bytes)) as SignedCommit; } catch { throw new SyncError('invalid-commit-json'); }
  assertSync(value !== null && typeof value === 'object' && /^[a-f0-9]{64}$/.test(value.sha256), 'invalid-commit-envelope');
  assertSync(Object.keys(value).every(key => ['commit', 'sha256'].includes(key)), 'unknown-envelope-field');
  validateCommit(value.commit, libraryId);
  return value;
}
export function commitPath(root: string, c: SyncCommit): string { return `${root}commits/${c.deviceId}/${String(c.sequence).padStart(16, '0')}.json`; }
