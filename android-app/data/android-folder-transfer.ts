import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import {
  createPortableManifest,
  importMarkdownFiles,
  importPortableManifest,
  MAX_MARKDOWN_FILES,
  MAX_MARKDOWN_FILE_CHARS,
  MAX_MARKDOWN_TOTAL_CHARS,
  parsePortableManifest,
  portableFileName,
  type ImportedMarkdownFile,
} from '@/data/portable-knowledge';

const { StorageAccessFramework } = FileSystem;
const MANIFEST_FILE_NAME = 'learnstuff.graph.json';

export type ImportFolderResult = {
  projectId: string;
  kind: 'portable' | 'markdown';
  markdownCount: number;
  title: string;
};

export type ExportFolderResult = {
  directoryUri: string;
  directoryName: string;
  documentCount: number;
  answerCount: number;
  sourceCount: number;
  masteryAttemptCount: number;
};

export type ExportProgress = {
  current: number;
  total: 7;
  label: string;
  detail?: string;
};

export async function pickAndImportKnowledgeFolder(db: SQLiteDatabase): Promise<ImportFolderResult | null> {
  assertAndroid();
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const topLevel = await StorageAccessFramework.readDirectoryAsync(permission.directoryUri);
  const manifestUri = topLevel.find((uri) => safName(uri).toLowerCase() === MANIFEST_FILE_NAME);
  if (manifestUri) {
    const raw = await StorageAccessFramework.readAsStringAsync(manifestUri);
    const manifest = parsePortableManifest(raw);
    const projectId = await importPortableManifest(db, manifest);
    return {
      projectId,
      kind: 'portable',
      markdownCount: manifest.documents.length,
      title: manifest.project.title,
    };
  }
  const files = await collectMarkdownFiles(permission.directoryUri);
  const title = safName(permission.directoryUri) || '导入的 Markdown';
  const projectId = await importMarkdownFiles(db, title, files);
  return { projectId, kind: 'markdown', markdownCount: files.length, title };
}

export async function pickAndExportProject(
  db: SQLiteDatabase,
  projectId: string,
  onProgress?: (progress: ExportProgress) => void,
): Promise<ExportFolderResult | null> {
  assertAndroid();
  onProgress?.({ current: 1, total: 7, label: '正在整理项目快照' });
  const manifest = await createPortableManifest(db, projectId);
  onProgress?.({ current: 2, total: 7, label: '请选择导出文件夹' });
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const stamp = compactTimestamp(new Date());
  const directoryName = `LearnStuff-${portableFileName(manifest.project.title, 'Project')}-${stamp}`;
  onProgress?.({ current: 3, total: 7, label: '正在创建导出目录' });
  const rootUri = await StorageAccessFramework.makeDirectoryAsync(permission.directoryUri, directoryName);
  const markerUri = await writeText(rootUri, 'INCOMPLETE.txt', 'text/plain', '导出尚未完成；不要导入这个目录。');
  try {
    const markdownUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'markdown');
    const nodesUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'nodes');
    const edgesUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'edges');
    const otherUri = await StorageAccessFramework.makeDirectoryAsync(markdownUri, 'other');
    const answersUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'answers');
    const nodeDocumentIds = new Map(manifest.nodes.map((node) => [node.documentId, node]));
    const edgeDocumentIds = new Map(manifest.edges.map((edge) => [edge.documentId, edge]));
    onProgress?.({ current: 4, total: 7, label: '正在写入 Markdown', detail: `0/${manifest.documents.length}` });
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
        total: 7,
        label: '正在写入 Markdown',
        detail: `${index + 1}/${manifest.documents.length}`,
      });
    }
    onProgress?.({ current: 5, total: 7, label: '正在写入收藏回答', detail: `0/${manifest.savedAnswers.length}` });
    for (const [index, answer] of manifest.savedAnswers.entries()) {
      await writeText(
        answersUri,
        `${portableFileName(answer.question, 'answer')}-${portableFileName(answer.id, 'id')}.md`,
        'text/markdown',
        answer.body,
      );
      onProgress?.({
        current: 5,
        total: 7,
        label: '正在写入收藏回答',
        detail: `${index + 1}/${manifest.savedAnswers.length}`,
      });
    }
    onProgress?.({ current: 6, total: 7, label: '正在写入图结构与说明' });
    await writeText(
      rootUri,
      'README.md',
      'text/markdown',
      `# ${manifest.project.title}\n\n这是 LearnStuff 便携知识图 v2。\n\n- \`${MANIFEST_FILE_NAME}\`：可重新导入的完整图结构、内容设置、提取后的资料与定位、掌握记录、资料引用和图谱修改批次\n- \`markdown/\`：节点、关系、来源派生稿和其他 Markdown\n- \`answers/\`：用户明确收藏的回答\n\n原始 PDF、照片等二进制资料默认不复制；清单会明确记录 \`originalAssetIncluded: false\`，同时保留原名、媒体类型、大小和内容哈希。请保留整个文件夹。`,
    );
    await writeText(rootUri, MANIFEST_FILE_NAME, 'application/json', JSON.stringify(manifest, null, 2));
    await StorageAccessFramework.deleteAsync(markerUri, { idempotent: true });
    onProgress?.({ current: 7, total: 7, label: '导出完成' });
    return {
      directoryUri: rootUri,
      directoryName,
      documentCount: manifest.documents.length,
      answerCount: manifest.savedAnswers.length,
      sourceCount: manifest.sourceItems?.length ?? 0,
      masteryAttemptCount: manifest.masteryAttempts?.length ?? 0,
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
