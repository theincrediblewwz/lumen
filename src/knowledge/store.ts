import { invoke } from '@tauri-apps/api/core';
import { emptyKnowledgeLibrary, validateKnowledgeLibrary, copyKnowledgeLibrary, type KnowledgeLibrary } from './core';
import { open, save } from '@tauri-apps/plugin-dialog';

export type KnowledgeSnapshot = { revision: string; library: KnowledgeLibrary };
export type KnowledgeDraft = { title: string; body: string; source: string; authorship: 'user' | 'source' | 'ai_adopted' };
export async function loadKnowledge(): Promise<KnowledgeSnapshot> {
  const result = await invoke<KnowledgeSnapshot>('knowledge_load');
  return { ...result, library: validateKnowledgeLibrary(result.library ?? emptyKnowledgeLibrary()) };
}
export async function saveKnowledge(library: KnowledgeLibrary, expectedRevision: string): Promise<string> {
  const revision = await invoke<string>('knowledge_save', { library: validateKnowledgeLibrary(library), expectedRevision });
  window.dispatchEvent(new CustomEvent('lumen:knowledge-changed'));
  return revision;
}
export async function openKnowledge(entryId?: string, revisionId?: string, draft?: KnowledgeDraft) {
  if ('__TAURI_INTERNALS__' in window) {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo('main', 'lumen://open-knowledge', { entryId, revisionId, draft });
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    await main?.show(); await main?.setFocus();
  } else window.dispatchEvent(new CustomEvent('lumen:open-knowledge', { detail: { entryId, revisionId, draft } }));
}
export async function exportKnowledgeFile() {
  const path = await save({ title: '导出独立知识库', defaultPath: `learnstuff-knowledge-${Date.now()}.json`, filters: [{ name: '知识库', extensions: ['json'] }] });
  if (path) await invoke('knowledge_export', { path });
}
export async function pickKnowledgeFile(): Promise<KnowledgeLibrary | null> {
  const path = await open({ title: '导入知识副本', multiple: false, filters: [{ name: '知识库', extensions: ['json'] }] });
  if (typeof path !== 'string') return null;
  const value = await invoke<unknown>('knowledge_import_read', { path });
  const copy = copyKnowledgeLibrary(value).library;
  return { ...copy, bindings: [], settings: [] };
}
