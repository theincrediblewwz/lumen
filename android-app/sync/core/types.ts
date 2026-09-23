/** Runtime-neutral protocol. Persist this state together with the projected domain transaction. */
export interface SyncEntity {
  id: string;
  kind: string;
  boardId: string | null;
  data: Record<string, unknown> | null;
}
export interface BlobRef { sha256: string; size: number; mediaType?: string }
export interface LocalChange {
  entity: SyncEntity;
  blobs?: BlobRef[];
  /** Ordinary edits specify the displayed head(s), or [] if no head matches the persisted projection.
   * Omit only for an intentional resolution of all current conflict versions. */
  parents?: string[];
}
export interface SyncChange { entity: SyncEntity; parents: string[]; blobs: BlobRef[] }
export interface SyncCommit {
  protocol: 1;
  libraryId: string;
  deviceId: string;
  sequence: number;
  id: string;
  previous: string | null;
  changes: SyncChange[];
}
export interface SignedCommit { commit: SyncCommit; sha256: string }
export interface SyncState {
  protocol: 1;
  libraryId: string;
  deviceId: string;
  nextSequence: number;
  commits: Record<string, SignedCommit>;
  heads: Record<string, string[]>;
  outbox: string[];
}
export interface ConflictVersion { revision: string; entity: SyncEntity; blobs: BlobRef[] }
export interface SyncConflict { key: string; versions: ConflictVersion[] }
export interface SyncApplication {
  state: SyncState;
  /** null means an outbox acknowledgement only. */
  commit: SyncCommit | null;
  /** Only single-head entities; conflicted entities retain the caller's existing projection. */
  entities: SyncEntity[];
  /** Complete current conflict set, including retained payloads and tombstones. */
  conflicts: SyncConflict[];
  blobs: { ref: BlobRef; bytes: Uint8Array }[];
}
export interface TransportEntry { path: string; directory: boolean }
export interface SyncTransport {
  ensureDirectories(paths: string[], signal?: AbortSignal): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<TransportEntry[]>;
  read(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Must not replace a different object; acknowledge retries only after checking bytes. */
  writeImmutable(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
}
export type Sha256 = (bytes: Uint8Array) => Promise<string>;
export interface SyncOptions {
  state: SyncState;
  transport: SyncTransport;
  sha256: Sha256;
  readBlob?: (ref: BlobRef) => Promise<Uint8Array>;
  /** Persist domain changes, conflicts, blob installation and state atomically/replayably. */
  apply: (application: SyncApplication) => Promise<void>;
  signal?: AbortSignal;
}
export interface SyncResult { state: SyncState; pulled: number; pushed: number; pending: string[] }
