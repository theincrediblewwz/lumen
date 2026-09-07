import { useEffect, useState } from 'react';
import { AiChat } from './AiChat';
import { openAiWindow, OPEN_AI_EVENT, type OpenAiArgs } from '../ai/aiWindow';

interface Props {
  projectId: string | null;
  boardId: string | null;
  boardName: string | null;
}

/**
 * 悬浮 AI 按钮（FAB，M5-1）。点击优先开独立 AI 窗口；
 * 浏览器预览 / 开窗失败时回退到应用内浮层面板（监听 OPEN_AI_EVENT）。
 */
export function AiFab({ projectId, boardId, boardName }: Props) {
  const [overlay, setOverlay] = useState<OpenAiArgs | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenAiArgs>).detail;
      setOverlay(detail);
    };
    window.addEventListener(OPEN_AI_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_AI_EVENT, onOpen as EventListener);
  }, []);

  // 没有选中白板时不显示 FAB（AI 需要白板上下文）
  if (!projectId || !boardId) return null;

  const open = () => {
    openAiWindow({ projectId, boardId, boardName: boardName ?? '白板' });
  };

  return (
    <>
      <button type="button" className="ai-fab" title="AI 助手" onClick={open}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3a9 9 0 0 0-9 9c0 1.6.42 3.1 1.15 4.4L3 21l4.7-1.12A8.96 8.96 0 0 0 12 21a9 9 0 0 0 0-18Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="8.5" cy="12" r="1.1" fill="currentColor" />
          <circle cx="12" cy="12" r="1.1" fill="currentColor" />
          <circle cx="15.5" cy="12" r="1.1" fill="currentColor" />
        </svg>
      </button>

      {overlay && (
        <div className="ai-overlay-backdrop" onClick={() => setOverlay(null)}>
          <div className="ai-overlay-panel" onClick={(e) => e.stopPropagation()}>
            <AiChat
              projectId={overlay.projectId}
              boardId={overlay.boardId}
              boardName={overlay.boardName}
              onClose={() => setOverlay(null)}
            />
          </div>
        </div>
      )}
    </>
  );
}
