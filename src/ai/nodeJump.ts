/**
 * 节点跳转（M5-6）。AI 对话窗里点击节点引用胶囊时调用：
 * 通知主窗口打开对应白板并高亮该节点。
 *
 * Tauri：向主窗口 emit 'lumen://jump-node' 事件（带 project/board/node）。
 * 浏览器预览：派发同名 CustomEvent，由 App 内直接处理。
 */

export interface JumpTarget {
  projectId: string;
  boardId: string;
  nodeId: string;
}

export const JUMP_NODE_EVENT = 'lumen://jump-node';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function jumpToNode(target: JumpTarget): Promise<void> {
  if (!inTauri()) {
    window.dispatchEvent(new CustomEvent<JumpTarget>(JUMP_NODE_EVENT, { detail: target }));
    return;
  }
  try {
    const { emit } = await import('@tauri-apps/api/event');
    // 广播给所有窗口；主窗口监听后处理，并把自己抬到最前
    await emit(JUMP_NODE_EVENT, target);
    // 尝试把主窗口带到前台
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    if (main) {
      try {
        if (await main.isMinimized()) await main.unminimize();
        await main.show();
        await main.setFocus();
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    // 回退：本窗口内派发（浮层模式下 App 在同文档里）
    window.dispatchEvent(new CustomEvent<JumpTarget>(JUMP_NODE_EVENT, { detail: target }));
  }
}
