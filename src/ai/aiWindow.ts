/**
 * AI 对话窗口开启（M5-1）。复用与阅读窗口相同的独立窗口范式：
 * 新开一个加载 index.html?ai=1 的 WebviewWindow，由 main.tsx 切到 AiApp。
 * 窗口绑定当前 project/board（通过 query 传递），AiApp 再拉取白板结构做上下文。
 *
 * 非 Tauri（浏览器预览）回退：派发 CustomEvent，由 App 内浮层 AI 面板接管。
 */

export interface OpenAiArgs {
  projectId: string;
  boardId: string;
  boardName: string;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const OPEN_AI_EVENT = 'lumen:open-ai';

function aiLabel(a: OpenAiArgs): string {
  const raw = `ai-${a.boardId}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export async function openAiWindow(a: OpenAiArgs): Promise<void> {
  if (!inTauri()) {
    window.dispatchEvent(new CustomEvent<OpenAiArgs>(OPEN_AI_EVENT, { detail: a }));
    return;
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = aiLabel(a);

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    try {
      if (await existing.isMinimized()) await existing.unminimize();
      await existing.show();
      await existing.setAlwaysOnTop(true);
      await existing.setFocus();
      setTimeout(() => existing.setAlwaysOnTop(false).catch(() => {}), 300);
    } catch {
      await existing.setFocus().catch(() => {});
    }
    return;
  }

  const params = new URLSearchParams({
    ai: '1',
    project: a.projectId,
    board: a.boardId,
    name: a.boardName,
  });

  const win = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: `AI 助手 · ${a.boardName} — 脉络 Lumen`,
    width: 520,
    height: 760,
    minWidth: 380,
    minHeight: 420,
    resizable: true,
    center: true,
    decorations: false,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  win.once('tauri://error', (e) => {
    console.error('AI 窗口创建失败，回退浮层：', e);
    window.dispatchEvent(new CustomEvent<OpenAiArgs>(OPEN_AI_EVENT, { detail: a }));
  });
}
