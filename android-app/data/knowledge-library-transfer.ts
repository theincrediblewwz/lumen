import type { SQLiteDatabase } from 'expo-sqlite';
import { loadKnowledgeLibrary, importKnowledgeLibrary } from './knowledge-library';
import { validateKnowledgeLibrary } from './knowledge-library-core';

/** This is the app's temporary exchange envelope, not HistoryandKnowledge's format. */
export const KNOWLEDGE_FILE_FORMAT = 'learnstuff-knowledge-library';
export function encodeKnowledgeFile(library: unknown) {
  return JSON.stringify({ format: KNOWLEDGE_FILE_FORMAT, version: 1, library: validateKnowledgeLibrary(library) }, null, 2);
}
export function decodeKnowledgeFile(text: string) {
  if (text.length > 32_000_000) throw new Error('知识文件超过 32 MB 限制');
  const value = JSON.parse(text);
  if (value?.format !== KNOWLEDGE_FILE_FORMAT || value.version !== 1) throw new Error('请选择本应用导出的知识库文件；HistoryandKnowledge 格式尚未接入');
  return validateKnowledgeLibrary(value.library);
}
export async function exportKnowledgeFile(db: SQLiteDatabase) {
  const { StorageAccessFramework: saf } = await import('expo-file-system/legacy');
  const permission = await saf.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const name = `learnstuff-knowledge-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`;
  const text = encodeKnowledgeFile(await loadKnowledgeLibrary(db));
  if (text.length > 32_000_000) throw new Error('知识文件超过 32 MB 限制');
  const uri = await saf.createFileAsync(permission.directoryUri, name, 'application/json');
  await saf.writeAsStringAsync(uri, text);
  return name;
}
export async function pickKnowledgeFile() {
  const picker = await import('expo-document-picker');
  const files = await import('expo-file-system/legacy');
  const result = await picker.getDocumentAsync({ type: ['application/json', 'text/plain'], copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  try {
    if ((asset.size ?? 0) > 32_000_000) throw new Error('知识文件超过 32 MB 限制');
    return decodeKnowledgeFile(await files.readAsStringAsync(asset.uri));
  } finally { await files.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined); }
}
export async function importKnowledgeFile(db: SQLiteDatabase, library: unknown) {
  // An independent file imports copies; no existing board permissions are transferred.
  let count = 0;
  await db.withExclusiveTransactionAsync(async tx => { count = (await importKnowledgeLibrary(tx, library)).size; });
  return count;
}
