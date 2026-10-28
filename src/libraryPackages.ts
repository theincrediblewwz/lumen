import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { loadWritePolicy } from './ai/boardOperations';
import { requestEditorFlush, releaseEditorLock } from './sync/events';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';
import { loadPrefs, savePrefs } from './reader/readerPrefs';

export type LibraryRestore = { root: string; preferences: { ui?: Partial<Settings>; reader?: ReturnType<typeof loadPrefs>; progress?: Record<string, number> }; files: number };
function cleanSettings(value: Partial<Settings>): Settings {
  return {
    theme: ['light', 'paper', 'dark'].includes(value.theme ?? '') ? value.theme! : DEFAULT_SETTINGS.theme,
    glass: typeof value.glass === 'boolean' ? value.glass : DEFAULT_SETTINGS.glass,
    glassMode: ['native', 'css', 'off'].includes(value.glassMode ?? '') ? value.glassMode! : DEFAULT_SETTINGS.glassMode,
    glassClarity: Number.isFinite(value.glassClarity) ? Math.max(0, Math.min(100, value.glassClarity!)) : DEFAULT_SETTINGS.glassClarity,
    glassBlur: Number.isFinite(value.glassBlur) ? Math.max(0, Math.min(100, value.glassBlur!)) : DEFAULT_SETTINGS.glassBlur,
    motion: typeof value.motion === 'boolean' ? value.motion : DEFAULT_SETTINGS.motion,
    edgeStyle: ['curved', 'straight', 'stepped'].includes(value.edgeStyle ?? '') ? value.edgeStyle! : DEFAULT_SETTINGS.edgeStyle,
    guessMath: typeof value.guessMath === 'boolean' ? value.guessMath : DEFAULT_SETTINGS.guessMath,
  };
}
function preferences(projectId?: string) {
  const current = loadSettings();
  const ui = cleanSettings(current);
  let progress: Record<string, number> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem('lumen.reader.progress.v1') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) progress = Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      key.length <= 4096 && (!projectId || key.startsWith(projectId + '/')) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) as Record<string, number>;
  } catch { /* A malformed preference never becomes executable or credential data. */ }
  return { ui, reader: loadPrefs(), progress };
}
export function applyLibraryPreferences(value: LibraryRestore['preferences']) {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object') return warnings;
  if (value.ui && typeof value.ui === 'object') saveSettings(cleanSettings(value.ui));
  if (value.reader && typeof value.reader === 'object') {
    // loadPrefs performs the same clamping as normal reader settings.
    try { localStorage.setItem('lumen.reader.prefs.v3', JSON.stringify(value.reader)); savePrefs(loadPrefs()); } catch { warnings.push('阅读显示偏好'); }
  }
  if (value.progress && typeof value.progress === 'object' && !Array.isArray(value.progress)) {
    const valid = Object.fromEntries(Object.entries(value.progress).filter(([key, ratio]) => key.length <= 4096 && typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1));
    let previous = {}; try { previous = JSON.parse(localStorage.getItem('lumen.reader.progress.v1') || '{}'); } catch { /* keep restored values */ }
    try { localStorage.setItem('lumen.reader.progress.v1', JSON.stringify({ ...previous, ...valid })); } catch { warnings.push('阅读进度偏好'); }
  }
  return warnings;
}
export async function exportLibraryPackage(project: { id: string; name: string } | undefined, onProgress: (text: string) => void) {
  const { scope } = await loadWritePolicy(); if (!scope) throw Error('请先选择资料目录');
  const title = project ? '导出完整项目资料包' : '备份全部内容';
  const name = project?.name.replace(/[<>:"/\\|?*\r\n]/g, '_') || 'Lumen-全部内容';
  const destination = await save({ title, defaultPath: `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.lumen-${project ? 'project' : 'library'}.zip`, filters: [{ name: 'Lumen 项目/全库资料包', extensions: ['zip'] }] });
  if (!destination) return;
  let locked = false, off = () => {};
  try {
    await requestEditorFlush(); locked = true;
    try { const { listen } = await import('@tauri-apps/api/event'); off = await listen<{ done: number; total: number }>('lumen://archive-progress', event => onProgress(`正在打包 ${event.payload.done}/${event.payload.total} 个文件`)); } catch { /* The native command still reports errors. */ }
    onProgress('正在核对全部文档、原件和历史');
    const result = await invoke<{ projects: number; boards: number; files: number }>('library_package_export', { projectId: project?.id ?? null, destination, expectedScope: scope, preferences: preferences(project?.id) });
    return { ...result, path: destination };
  } finally { off(); if (locked) await releaseEditorLock().catch(() => {}); }
}
export async function restoreLibraryPackage(): Promise<LibraryRestore | undefined> {
  const { scope } = await loadWritePolicy(); if (!scope) throw Error('请先选择当前资料目录');
  const srcPath = await open({ title: '选择项目或全库资料包', multiple: false, filters: [{ name: 'Lumen 项目/全库资料包', extensions: ['zip'] }] });
  if (typeof srcPath !== 'string') return;
  const parentPath = await open({ title: '选择恢复位置（将在其中新建资料目录，保留原库）', directory: true, multiple: false });
  if (typeof parentPath !== 'string') return;
  return invoke<LibraryRestore>('library_package_restore', { srcPath, parentPath, expectedScope: scope });
}
