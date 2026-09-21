import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Native builder enforces the exe-adjacent WebView profile in preview builds. */
export async function openPreviewWindow(
  label: string,
  options: ConstructorParameters<typeof WebviewWindow>[1],
): Promise<WebviewWindow> {
  await invoke('preview_window_open', { options: { ...options, label, titleBarStyle: 'Overlay' } });
  const window = await WebviewWindow.getByLabel(label);
  if (!window) throw new Error('预览窗口创建后未找到');
  return window;
}
