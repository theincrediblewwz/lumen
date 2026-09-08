import { useEffect, useRef, useState } from 'react';
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

  /* ── FAB 可拖动，位置持久化；拖动与点击区分（移动超过阈值算拖动，不触发打开） ── */
  const POS_KEY = 'lumen.aiFab.pos.v1';
  type Pos = { right: number; bottom: number };
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      return raw ? (JSON.parse(raw) as Pos) : { right: 24, bottom: 24 };
    } catch {
      return { right: 24, bottom: 24 };
    }
  });
  const draggingRef = useRef(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenAiArgs>).detail;
      setOverlay(detail);
    };
    window.addEventListener(OPEN_AI_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_AI_EVENT, onOpen as EventListener);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* 忽略 */
    }
  }, [pos]);

  // 没有选中白板时不显示 FAB（AI 需要白板上下文）
  if (!projectId || !boardId) return null;

  const open = () => {
    if (draggingRef.current) return; // 刚拖动完，不当作点击
    openAiWindow({ projectId, boardId, boardName: boardName ?? '白板' });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...pos };
    draggingRef.current = false;
    const SIZE = 52;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!draggingRef.current && Math.hypot(dx, dy) > 4) draggingRef.current = true;
      if (!draggingRef.current) return;
      // right/bottom 锚定：向右拖 right 减小，向下拖 bottom 减小
      const right = Math.min(Math.max(base.right - dx, 8), window.innerWidth - SIZE - 8);
      const bottom = Math.min(Math.max(base.bottom - dy, 8), window.innerHeight - SIZE - 8);
      setPos({ right, bottom });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // 让本次 click 判断后再复位，避免拖动结尾误触发打开
      setTimeout(() => (draggingRef.current = false), 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <>
      <button
        type="button"
        className="ai-fab"
        title="AI 助手（可拖动）"
        style={{ right: pos.right, bottom: pos.bottom }}
        onPointerDown={onPointerDown}
        onClick={open}
      >
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

