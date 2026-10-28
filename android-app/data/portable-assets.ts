import type { PortableGraphManifest } from '@/data/portable-knowledge';

export const PORTABLE_ASSETS_FORMAT = 'learnstuff-assets' as const;
export const PORTABLE_ASSETS_VERSION = 1 as const;
export const MAX_PORTABLE_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PORTABLE_ASSET_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_PORTABLE_ASSET_COUNT = 500;

export type PortableAssetEntry = {
  sourceId: string;
  sha256: string;
  size: number;
  mediaType: string;
  fileName: string;
};

export type PortableAssetsIndex = {
  format: typeof PORTABLE_ASSETS_FORMAT;
  version: typeof PORTABLE_ASSETS_VERSION;
  projectId: string;
  manifestSha256: string;
  assets: PortableAssetEntry[];
  missingSourceIds: string[];
};

const digestPattern = /^[a-f0-9]{64}$/;
const assetFilePattern = /^[a-f0-9]{64}(?:\.[A-Za-z0-9]{1,16})?$/;

export function validatePortableAssetsIndex(raw: string, manifest: PortableGraphManifest, manifestSha256: string): PortableAssetsIndex {
  if (raw.length > 1_000_000) throw new Error('原件索引超过上限');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('原件索引不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原件索引格式错误');
  const index = value as Record<string, unknown>;
  if (index.format !== PORTABLE_ASSETS_FORMAT || index.version !== PORTABLE_ASSETS_VERSION) throw new Error('原件索引版本不受支持');
  if (index.projectId !== manifest.project.id || index.manifestSha256 !== manifestSha256) throw new Error('原件索引与图谱清单不匹配');
  if (!Array.isArray(index.assets) || index.assets.length > MAX_PORTABLE_ASSET_COUNT
      || !Array.isArray(index.missingSourceIds) || index.missingSourceIds.length > MAX_PORTABLE_ASSET_COUNT) throw new Error('原件索引项目过多');
  const sources = new Map((manifest.sourceItems ?? []).map(source => [source.id, source]));
  const covered = new Set<string>();
  const assets: PortableAssetEntry[] = [];
  let total = 0;
  for (const value of index.assets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原件条目格式错误');
    const item = value as Record<string, unknown>;
    const source = typeof item.sourceId === 'string' ? sources.get(item.sourceId) : null;
    if (!source || covered.has(source.id)) throw new Error('原件来源不存在或重复');
    if (typeof item.sha256 !== 'string' || !digestPattern.test(item.sha256)
        || typeof item.fileName !== 'string' || !assetFilePattern.test(item.fileName)
        || !item.fileName.startsWith(item.sha256)) throw new Error('原件文件名或指纹无效');
    if (!Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > MAX_PORTABLE_ASSET_BYTES) throw new Error('原件大小无效或超过 32 MB');
    if (item.mediaType !== source.mediaType) throw new Error('原件媒体类型与来源不匹配');
    total += item.size as number;
    if (total > MAX_PORTABLE_ASSET_TOTAL_BYTES) throw new Error('原件总大小超过 512 MB');
    covered.add(source.id);
    assets.push({ sourceId: source.id, sha256: item.sha256, size: item.size as number, mediaType: source.mediaType, fileName: item.fileName });
  }
  const missingSourceIds: string[] = [];
  for (const value of index.missingSourceIds) {
    const source = typeof value === 'string' ? sources.get(value) : null;
    if (!source?.originalName || covered.has(source.id)) throw new Error('缺失原件的来源不存在或重复');
    covered.add(source.id);
    missingSourceIds.push(source.id);
  }
  for (const source of sources.values()) {
    if (source.originalName && !covered.has(source.id)) throw new Error(`来源“${source.title}”的原件未列入索引`);
  }
  return {
    format: PORTABLE_ASSETS_FORMAT,
    version: PORTABLE_ASSETS_VERSION,
    projectId: manifest.project.id,
    manifestSha256,
    assets,
    missingSourceIds,
  };
}
