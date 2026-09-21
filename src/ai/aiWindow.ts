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
  conversationId?: string;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 是否 macOS（决定新窗口用原生装饰还是无边框自绘）。失败时保守按非 mac。 */
async function windowEnvironment(): Promise<{isMac:boolean;dataDirectory?:string}> {
  try {
    const { api } = await import('../api');
    const info = await api.appInfo();
    return {isMac:info.platform === 'macos',dataDirectory:info.preview_data_dir??undefined};
  } catch {
    return {isMac:false};
  }
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

  // macOS 用原生装饰（系统红绿灯 + 圆角 + 阴影）；Windows/Linux 无边框自绘按钮。
  const {isMac,dataDirectory} = await windowEnvironment();

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    if(a.conversationId){const {emitTo}=await import('@tauri-apps/api/event');await emitTo(label,'lumen://open-conversation',{boardId:a.boardId,conversationId:a.conversationId});}
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
  if(a.conversationId)params.set('conversation',a.conversationId);

  const options = {
    url: `index.html?${params.toString()}`,
    title: `AI 助手 · ${a.boardName} — 脉络 Lumen`,
    width: 520,
    height: 760,
    minWidth: 380,
    minHeight: 420,
    resizable: true,
    center: true,
    // macOS：原生装饰 + Overlay 标题栏（红绿灯/圆角/阴影由系统提供）；
    // 其它平台：无边框，右侧自绘窗口按钮。
    decorations: isMac,
    transparent: isMac,
    titleBarStyle: 'overlay' as const,
    hiddenTitle: true,
  };
  const win = dataDirectory
    ? await (await import('../previewWindow')).openPreviewWindow(label, options)
    : new WebviewWindow(label, options);

  win.once('tauri://error', (e) => {
    console.error('AI 窗口创建失败，回退浮层：', e);
    window.dispatchEvent(new CustomEvent<OpenAiArgs>(OPEN_AI_EVENT, { detail: a }));
  });
}


