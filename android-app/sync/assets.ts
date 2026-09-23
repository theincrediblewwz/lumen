import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import type { SyncAssets } from '../data/sync-repository';
import type { BlobRef } from './core/types';
import { installVerifiedBlob, verifyBlobBytes } from './blob-installation';

export async function sha256(bytes: Uint8Array) {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
function blobFile(ref: BlobRef) {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('附件校验信息无效或超过 32 MB；同步已暂停，原文件仍保留');
  }
  const directory = new Directory(Paths.document, 'sync-blobs');
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, ref.sha256);
}

export const syncAssets: SyncAssets = {
  async exportFile(uri, mediaType) {
    // Importers first copy originals into private document/cache storage; never read arbitrary host paths.
    if (![Paths.document.uri, Paths.cache.uri].some((base) => uri.startsWith(base.endsWith('/') ? base : `${base}/`)) || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(uri))) {
      throw new Error('原始附件尚未保存在应用私有目录，请重新导入该资料后同步');
    }
    const file = new File(uri);
    if (!file.exists || file.size > MAX_ATTACHMENT_BYTES) throw new Error('原始附件不可读或超过 32 MB；请保留原文件并检查资料');
    const bytes = await file.bytes();
    const ref: BlobRef = { sha256: await sha256(bytes), size: bytes.byteLength, mediaType };
    const existingBlobHash = uri.match(/\/sync-blobs\/([a-f0-9]{64})$/)?.[1];
    if (existingBlobHash && existingBlobHash !== ref.sha256) throw new Error('附件本机副本校验失败，已停止上传以保护服务端原件');
    await this.install(ref, bytes);
    return ref;
  },
  async install(ref, bytes) {
    return installVerifiedBlob(ref, bytes, sha256, {
      destination: () => blobFile(ref),
      staging: () => new File(Paths.document, 'sync-blobs', `pending-${Crypto.randomUUID()}.part`),
      quarantine: () => new File(Paths.document, 'sync-blobs', `corrupt-${ref.sha256}-${Crypto.randomUUID()}`),
      reopen: (uri) => new File(uri),
    });
  },
  async localUri(ref) {
    const file = blobFile(ref);
    if (!file.exists) throw new Error('附件尚未下载完整，已保留同步位置等待恢复');
    await verifyBlobBytes(ref, await file.bytes(), sha256);
    return file.uri;
  },
};

export async function readSyncBlob(ref: BlobRef) {
  const file = new File(await syncAssets.localUri(ref));
  return file.bytes();
}
