import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import {
  createPortableManifest,
  importMarkdownFiles,
  importPortableManifest,
  importPortableManifestWithMapping,
  MAX_MARKDOWN_FILES,
  MAX_MARKDOWN_FILE_CHARS,
  MAX_MARKDOWN_TOTAL_CHARS,
  parsePortableManifest,
  portableFileName,
  type ImportedMarkdownFile,
} from '@/data/portable-knowledge';
import {
  MAX_PORTABLE_ASSET_COUNT, MAX_PORTABLE_ASSET_TOTAL_BYTES,
  PORTABLE_ASSETS_FORMAT, PORTABLE_ASSETS_VERSION, validatePortableAssetsIndex,
  type PortableAssetEntry, type PortableAssetsIndex,
} from '@/data/portable-assets';
import { readSyncBlob, sha256, syncAssets } from '@/sync/assets';
import { verifyBlobBytes } from '@/sync/blob-installation';

const { StorageAccessFramework } = FileSystem;
const MANIFEST_FILE_NAME = 'learnstuff.graph.json';
const ASSETS_INDEX_FILE_NAME = 'learnstuff.assets.json';
const INCOMPLETE_FILE_NAME = 'INCOMPLETE.txt';

export type ImportFolderResult = {
  projectId: string;
  kind: 'portable' | 'markdown';
  markdownCount: number;
  title: string;
  restoredAssetCount: number;
  missingAssetCount: number;
};

export type ExportFolderResult = {
  directoryUri: string;
  directoryName: string;
  documentCount: number;
  answerCount: number;
  sourceCount: number;
  masteryAttemptCount: number;
  assetCount: number;
  missingAssetCount: number;
};

export type ExportProgress = {
  current: number;
  total: 8;
  label: string;
  detail?: string;
};

export async function pickAndImportKnowledgeFolder(db: SQLiteDatabase): Promise<ImportFolderResult | null> {
  assertAndroid();
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const topLevel = await StorageAccessFramework.readDirectoryAsync(permission.directoryUri);
  if (topLevel.some(uri => safName(uri).toLowerCase() === INCOMPLETE_FILE_NAME.toLowerCase())) throw new Error('这个导出目录尚未完成，不能恢复');
  const manifestUri = topLevel.find((uri) => safName(uri).toLowerCase() === MANIFEST_FILE_NAME);
  if (manifestUri) {
    const raw = await StorageAccessFramework.readAsStringAsync(manifestUri);
    const manifest = parsePortableManifest(raw);
    const indexUri = topLevel.find(uri => safName(uri).toLowerCase() === ASSETS_INDEX_FILE_NAME);
    const assetUris = new Map<string, string>();
    let missingAssetCount = (manifest.sourceItems ?? []).filter(source => source.originalName).length;
    if (indexUri) {
      const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
      const index = validatePortableAssetsIndex(await StorageAccessFramework.readAsStringAsync(indexUri), manifest, digest);
      missingAssetCount = index.missingSourceIds.length;
      const assetsDirectory = topLevel.find(uri => safName(uri).toLowerCase() === 'assets');
      if (index.assets.length && !assetsDirectory) throw new Error('原件目录不存在，未创建项目副本');
      const files = assetsDirectory ? await StorageAccessFramework.readDirectoryAsync(assetsDirectory) : [];
      const byName = new Map(files.map(uri => [safName(uri), uri]));
      for (const entry of index.assets) {
        const uri = byName.get(entry.fileName);
        if (!uri) throw new Error(`原件 ${entry.fileName} 缺失，未创建项目副本`);
        const bytes = await new File(uri).bytes();
        const ref = { sha256: entry.sha256, size: entry.size, mediaType: entry.mediaType };
        await verifyBlobBytes(ref, bytes, sha256);
        await syncAssets.install(ref, bytes);
        assetUris.set(entry.sourceId, await syncAssets.localUri(ref));
      }
    }
    const projectId = indexUri
      ? (await importPortableManifestWithMapping(db, manifest, assetUris)).projectId
      : await importPortableManifest(db, manifest);
    return {
      projectId,
      kind: 'portable',
      markdownCount: manifest.documents.length,
      title: manifest.project.title,
      restoredAssetCount: assetUris.size,
      missingAssetCount,
    };
  }
  const files = await collectMarkdownFiles(permission.directoryUri);
  const title = safName(permission.directoryUri) || '导入的 Markdown';
  const projectId = await importMarkdownFiles(db, title, files);
  return { projectId, kind: 'markdown', markdownCount: files.length, title, restoredAssetCount: 0, missingAssetCount: 0 };
}

export async function pickAndExportProject(
  db: SQLiteDatabase,
  projectId: string,
  onProgress?: (progress: ExportProgress) => void,
): Promise<ExportFolderResult | null> {
  assertAndroid();
  onProgress?.({ current: 1, total: 8, label: '正在整理项目快照' });
  const manifest = await createPortableManifest(db, projectId);
  const sourceRows = await db.getAllAsync<{ id: string; original_name: string | null; media_type: string; asset_uri: string | null }>(
    'SELECT id,original_name,media_type,asset_uri FROM source_items WHERE project_id=? ORDER BY id', projectId,
  );
  if (sourceRows.length !== (manifest.sourceItems ?? []).length
      || sourceRows.some(row => !(manifest.sourceItems ?? []).some(source => source.id === row.id && source.mediaType === row.media_type))) {
    throw new Error('导出时来源已变化，请重试');
  }
  if (sourceRows.filter(row => row.asset_uri).length > MAX_PORTABLE_ASSET_COUNT) throw new Error('项目原件超过 500 个上限');
  onProgress?.({ current: 2, total: 8, label: '请选择导出文件夹' });
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const stamp = compactTimestamp(new Date());
  const directoryName = `LearnStuff-${portableFileName(manifest.project.title, 'Project')}-${stamp}`;
  onProgress?.({ current: 3, total: 8, label: '正在创建导出目录' });
  const rootUri = await StorageAccessFramework.makeDirectoryAsync(permission.directoryUri, directoryName);
  const markerUri = await writeText(rootUri, INCOMPLETE_FILE_NAME, 'text/plain', '导出尚未完成；不要导入这个目录。');
  try {
    const markdownUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'markdown');
    const nodesUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'nodes');
    const edgesUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'edges');
    const otherUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'other');
    const answersUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'answers');
    const nodeDocumentIds = new Map(manifest.nodes.map((node) => [node.documentId, node]));
    const edgeDocumentIds = new Map(manifest.edges.map((edge) => [edge.documentId, edge]));
    onProgress?.({ current: 4, total: 8, label: '正在写入 Markdown', detail: `0/${manifest.documents.length}` });
    for (const [index, document] of manifest.documents.entries()) {
      const node = nodeDocumentIds.get(document.id);
      const edge = edgeDocumentIds.get(document.id);
      const destination = node ? nodesUri : edge ? edgesUri : otherUri;
      const label = node?.title ?? edge?.id ?? document.title;
      await writeText(
        destination,
        `${portableFileName(label, 'document')}-${portableFileName(document.id, 'id')}.md`,
        'text/markdown',
        document.body,
      );
      onProgress?.({
        current: 4,
        total: 8,
        label: '正在写入 Markdown',
        detail: `${index + 1}/${manifest.documents.length}`,
      });
    }
    onProgress?.({ current: 5, total: 8, label: '正在写入收藏回答', detail: `0/${manifest.savedAnswers.length}` });
    for (const [index, answer] of manifest.savedAnswers.entries()) {
      await writeText(
        answersUri,
        `${portableFileName(answer.question, 'answer')}-${portableFileName(answer.id, 'id')}.md`,
        'text/markdown',
        answer.body,
      );
      onProgress?.({
        current: 5,
        total: 8,
        label: '正在写入收藏回答',
        detail: `${index + 1}/${manifest.savedAnswers.length}`,
      });
    }
    const assetsUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'assets');
    const fileNames = new Map<string, string>();
    const assets: PortableAssetEntry[] = [];
    const missingSourceIds: string[] = [];
    let totalAssetBytes = 0;
    const expectedAssets = sourceRows.filter(row => row.asset_uri).length;
    for (const row of sourceRows) {
      if (!row.asset_uri) {
        if (row.original_name) missingSourceIds.push(row.id);
        continue;
      }
      onProgress?.({ current: 6, total: 8, label: '正在复制并校验原件', detail: `${assets.length}/${expectedAssets}` });
      const ref = await syncAssets.exportFile(row.asset_uri, row.media_type);
      totalAssetBytes += ref.size;
      if (totalAssetBytes > MAX_PORTABLE_ASSET_TOTAL_BYTES) throw new Error('项目原件总大小超过 512 MB 上限');
      let fileName = fileNames.get(ref.sha256);
      if (!fileName) {
        const bytes = await readSyncBlob(ref);
        const fileUri = await StorageAccessFramework.createFileAsync(assetsUri, ref.sha256, row.media_type);
        new File(fileUri).write(bytes);
        await verifyBlobBytes(ref, await new File(fileUri).bytes(), sha256);
        fileName = safName(fileUri);
        fileNames.set(ref.sha256, fileName);
      }
      assets.push({ sourceId: row.id, sha256: ref.sha256, size: ref.size, mediaType: row.media_type, fileName });
    }
    const sourceRowsAfter = await db.getAllAsync<typeof sourceRows[number]>(
      'SELECT id,original_name,media_type,asset_uri FROM source_items WHERE project_id=? ORDER BY id', projectId,
    );
    if (JSON.stringify(sourceRowsAfter) !== JSON.stringify(sourceRows)) throw new Error('导出期间来源已变化，请重试');
    const manifestRaw = JSON.stringify(manifest, null, 2);
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, manifestRaw);
    const assetsIndex: PortableAssetsIndex = {
      format: PORTABLE_ASSETS_FORMAT, version: PORTABLE_ASSETS_VERSION,
      projectId: manifest.project.id, manifestSha256: digest, assets, missingSourceIds,
    };
    validatePortableAssetsIndex(JSON.stringify(assetsIndex), manifest, digest);
    onProgress?.({ current: 7, total: 8, label: '正在写入图结构与说明' });
    await writeText(
      rootUri,
      'README.md',
      'text/markdown',
      `# ${manifest.project.title}\n\n这是 LearnStuff 便携知识图 v4。\n\n- \`${MANIFEST_FILE_NAME}\`：可重新导入的图结构、文档、对话与复习记录\n- \`${ASSETS_INDEX_FILE_NAME}\` 与 \`assets/\`：已复制的 ${assets.length} 份原件及逐文件 SHA-256 校验\n- \`markdown/\`：节点、关系、来源派生稿和其他 Markdown\n- \`answers/\`：用户明确收藏的回答\n\n本机缺失 ${missingSourceIds.length} 份旧来源原件，无法从提取文本重建。请保留整个文件夹；单独的图谱 JSON 不包含原件字节。`,
    );
    await writeText(rootUri, ASSETS_INDEX_FILE_NAME, 'application/json', JSON.stringify(assetsIndex, null, 2));
    await writeText(rootUri, MANIFEST_FILE_NAME, 'application/json', manifestRaw);
    await StorageAccessFramework.deleteAsync(markerUri, { idempotent: true });
    onProgress?.({ current: 8, total: 8, label: '导出完成' });
    return {
      directoryUri: rootUri,
      directoryName,
      documentCount: manifest.documents.length,
      answerCount: manifest.savedAnswers.length,
      sourceCount: manifest.sourceItems?.length ?? 0,
      masteryAttemptCount: manifest.masteryAttempts?.length ?? 0,
      assetCount: assets.length,
      missingAssetCount: missingSourceIds.length,
    };
  } catch (error) {
    throw new Error(`导出未完成，目标目录保留了 INCOMPLETE 标记。${error instanceof Error ? ` ${error.message}` : ''}`);
  }
}

async function collectMarkdownFiles(rootUri: string): Promise<ImportedMarkdownFile[]> {
  const files: ImportedMarkdownFile[] = [];
  const visited = new Set<string>();
  let totalChars = 0;
  let scannedEntries = 0;
  async function visit(directoryUri: string, prefix: string, depth: number) {
    if (depth > 12) throw new Error('文件夹层级超过 12 层上限');
    if (visited.has(directoryUri)) return;
    visited.add(directoryUri);
    const entries = await StorageAccessFramework.readDirectoryAsync(directoryUri);
    for (const uri of entries) {
      scannedEntries += 1;
      if (scannedEntries > 1_000) throw new Error('文件夹项目超过 1000 项扫描上限');
      const name = safName(uri);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      let children: string[] | null = null;
      try {
        children = await StorageAccessFramework.readDirectoryAsync(uri);
      } catch {
        children = null;
      }
      if (children) {
        await visit(uri, relativePath, depth + 1);
        continue;
      }
      if (!/\.md(?:own)?$/i.test(name)) continue;
      if (files.length >= MAX_MARKDOWN_FILES) throw new Error(`Markdown 文件超过 ${MAX_MARKDOWN_FILES} 个上限`);
      const body = await StorageAccessFramework.readAsStringAsync(uri);
      if (body.length > MAX_MARKDOWN_FILE_CHARS) throw new Error(`${relativePath} 超过 1 MB 上限`);
      totalChars += body.length;
      if (totalChars > MAX_MARKDOWN_TOTAL_CHARS) throw new Error('Markdown 总内容超过 12 MB 上限');
      files.push({ relativePath, body });
    }
  }
  await visit(rootUri, '', 0);
  return files;
}

async function writeText(parentUri: string, fileName: string, mimeType: string, contents: string) {
  const uri = await StorageAccessFramework.createFileAsync(parentUri, fileName, mimeType);
  await StorageAccessFramework.writeAsStringAsync(uri, contents);
  return uri;
}

export function safName(uri: string) {
  try {
    const decoded = decodeURIComponent(uri);
    const tail = decoded.split('/').filter(Boolean).at(-1) ?? '';
    return tail.includes(':') ? tail.split(':').at(-1) ?? tail : tail;
  } catch {
    return '本地文件夹';
  }
}

function compactTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function assertAndroid() {
  if (Platform.OS !== 'android') throw new Error('文件夹导入导出当前仅支持 Android');
}
