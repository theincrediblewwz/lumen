import { useCallback, useEffect, useRef, useState } from 'react';
import { AiChat } from './AiChat';
import { MessageCircle } from 'lucide-react';
import { openAiWindow, OPEN_AI_EVENT, type OpenAiArgs } from '../ai/aiWindow';

interface Props {
  projectId: string | null;
  boardId: string | null;
  boardName: string | null;
  suspended?: boolean;
}

/**
 * 悬浮 AI 按钮（FAB，M5-1）。点击优先开独立 AI 窗口；
 * 浏览器预览 / 开窗失败时回退到应用内浮层面板（监听 OPEN_AI_EVENT）。
 */
export function AiFab({ projectId, boardId, boardName, suspended = false }: Props) {
  const [overlay,setOverlay]=useState<string|null>(null);
  const [panels,setPanels]=useState<Record<string,OpenAiArgs>>({});
  const [retention,setRetention]=useState<Record<string,boolean>>({});
  const onRetentionChange=useCallback((key:string,retained:boolean)=>setRetention(prev=>prev[key]===retained?prev:{...prev,[key]:retained}),[]);
  useEffect(()=>{setPanels(prev=>{const next=Object.fromEntries(Object.entries(prev).filter(([key])=>key===overlay||retention[key]!==false));return Object.keys(next).length===Object.keys(prev).length?prev:next;});},[overlay,retention]);
  const closeOverlay=()=>setOverlay(null);

  /* ── FAB 可拖动，位置持久化；拖动与点击区分（移动超过阈值算拖动，不触发打开） ── */
  const POS_KEY = 'lumen.aiFab.pos.v1';
  type Pos = { right: number; bottom: number };
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      const value = raw ? JSON.parse(raw) as Pos : null;
      return value && Number.isFinite(value.right) && Number.isFinite(value.bottom) ? value : { right: 24, bottom: 24 };
    } catch {
      return { right: 24, bottom: 24 };
    }
  });
  const draggingRef = useRef(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => {
    const fit = () => setPos(p => ({ right: Math.min(Math.max(8, p.right), Math.max(8, window.innerWidth - 112)), bottom: Math.min(Math.max(8, p.bottom), Math.max(8, window.innerHeight - 60)) }));
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenAiArgs>).detail;
      const key=`${detail.projectId}:${detail.boardId}:${detail.nodeId??'board'}`;
      setPanels(prev=>({...prev,[key]:detail}));setOverlay(key);
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
  if ((!projectId || !boardId) && !Object.keys(panels).length) return null;

  const open = () => {
    if (draggingRef.current) return; // 刚拖动完，不当作点击
    if(!projectId||!boardId)return;
    openAiWindow({ projectId, boardId, boardName: boardName ?? '白板' });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...pos };
    draggingRef.current = false;
    const SIZE = 96;
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
      window.removeEventListener('pointercancel', onUp);
      dragCleanup.current = null;
      // 让本次 click 判断后再复位，避免拖动结尾误触发打开
      setTimeout(() => (draggingRef.current = false), 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanup.current = onUp;
  };

  return (
    <>
      <button
        type="button"
        className="ai-fab"
        title="与 AI 对话（可拖动）"
        aria-label="与 AI 对话"
        style={{ right: pos.right, bottom: pos.bottom, visibility: suspended || !projectId || !boardId ? 'hidden' : undefined }}
        onPointerDown={onPointerDown}
        onClick={open}
      >
        <MessageCircle size={18} strokeWidth={1.7} aria-hidden="true"/><span>问 AI</span>
      </button>

      {Object.entries(panels).map(([key,panel])=>(
        <div key={key} className="ai-overlay-backdrop" hidden={key!==overlay} style={suspended||key!==overlay ? { visibility:'hidden',pointerEvents:'none',display:'none' } : undefined} onClick={closeOverlay}>
          <div className="ai-overlay-panel" onClick={e=>e.stopPropagation()}>
            <AiChat nodeId={panel.nodeId} projectId={panel.projectId} boardId={panel.boardId} boardName={panel.boardName} conversationId={panel.conversationId} messageIds={panel.messageIds} visible={!suspended&&key===overlay} onClose={closeOverlay} retentionKey={key} onRetentionChange={onRetentionChange}/>
          </div>
        </div>
      ))}
    </>
  );
}
