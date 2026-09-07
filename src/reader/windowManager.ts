/**
 * 阅读窗口管理（M4-4）。
 *
 * 优先开**独立 Tauri 窗口**（真机多窗口体验，主目标 macOS）；每篇文档一个窗口，
 * 已存在则聚焦复用。窗口加载同一个 index.html，用 query 参数 `?reader=1&…`
 * 让 main.tsx 切到 ReaderApp，再由 ReaderApp 通过 Tauri 命令按 project/board/path
 * 拉取文档内容（不把大正文塞进 URL）。
 *
 * 非 Tauri 环境（浏览器预览 / Web）自动回退：派发一个 CustomEvent，由 App 内的
 * 浮层阅读器接管，保证开发预览也能看到效果。
 */

export interface OpenReaderArgs {
  projectId: string;
  boardId: string;
  path: string; // docs/xxx.md
  title: string;
}

/** 运行在 Tauri 里？（存在注入的 __TAURI_INTERNALS__） */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 供浏览器回退用的事件名。 */
export const OPEN_READER_EVENT = 'lumen:open-reader';

function readerLabel(a: OpenReaderArgs): string {
  // 窗口 label 只能包含字母数字/-/_/:，这里做一次安全化
  const raw = `reader-${a.boardId}-${a.path}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export async function openReaderWindow(a: OpenReaderArgs): Promise<void> {
  if (!inTauri()) {
    // 浏览器/预览：交给应用内浮层
    window.dispatchEvent(new CustomEvent<OpenReaderArgs>(OPEN_READER_EVENT, { detail: a }));
    return;
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = readerLabel(a);

  // 已有同文档窗口则聚焦复用
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const params = new URLSearchParams({
    reader: '1',
    project: a.projectId,
    board: a.boardId,
    path: a.path,
    title: a.title,
  });

  const win = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: `${a.title} — 脉络 Lumen`,
    width: 860,
    height: 900,
    minWidth: 480,
    minHeight: 400,
    resizable: true,
    center: true,
    // 阅读窗口与主窗一致：隐藏系统装饰，改用应用自绘标题栏（跟随软件主体，
    // 不再出现 Windows 原生标题栏那种割裂感）。macOS 用 Overlay 保留红绿灯。
    decorations: false,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });

  win.once('tauri://error', (e) => {
    // 新窗口创建失败时回退到应用内浮层，至少不让用户点了没反应
    console.error('阅读窗口创建失败，回退浮层：', e);
    window.dispatchEvent(new CustomEvent<OpenReaderArgs>(OPEN_READER_EVENT, { detail: a }));
  });
}

