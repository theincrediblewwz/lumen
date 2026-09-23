import type { BlobRef, Sha256 } from './core';

export interface BlobFile<TFile> {
  uri: string;
  exists: boolean;
  bytes(): Promise<Uint8Array>;
  write(bytes: Uint8Array): void;
  move(destination: TFile): void;
  delete(): void;
}
type BlobFiles<TFile> = { destination(): TFile; staging(): TFile; quarantine(): TFile; reopen(uri: string): TFile };

export async function verifyBlobBytes(ref: BlobRef, bytes: Uint8Array, sha256: Sha256) {
  if (bytes.byteLength !== ref.size || await sha256(bytes) !== ref.sha256) throw new Error('附件内容校验失败，已保留原数据');
}

/** Hash-addressed app-private copies only. User originals are never moved or removed. */
export async function installVerifiedBlob<TFile extends BlobFile<TFile>>(ref: BlobRef, bytes: Uint8Array, sha256: Sha256, files: BlobFiles<TFile>) {
  await verifyBlobBytes(ref, bytes, sha256);
  const destination = files.destination();
  if (destination.exists) {
    try { await verifyBlobBytes(ref, await destination.bytes(), sha256); return destination.uri; }
    catch { files.destination().move(files.quarantine()); }
  }
  const staging = files.staging(); const originalStagingUri = staging.uri;
  try {
    staging.write(bytes);
    await verifyBlobBytes(ref, await staging.bytes(), sha256);
    staging.move(destination);
    await verifyBlobBytes(ref, await destination.bytes(), sha256);
    return destination.uri;
  } finally {
    // Native File.move updates its object's URI. Never delete that now-published object.
    const leftover = files.reopen(originalStagingUri);
    if (leftover.exists) leftover.delete();
  }
}
