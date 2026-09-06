import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasEngine, type Viewport } from '../canvas/CanvasEngine';
import {
  createHistory,
  pushState,
  replacePresent,
  commitFromBaseline,
  undo as histUndo,
  redo as histRedo,
  canUndo,
  canRedo,
  type History,
} from '../canvas/history';
import type { BoardFile, BoardNode } from '../api';
import { NodeCard } from './NodeCard';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

/** 生成一个前端本地节点 id（后端保存时沿用；与 Rust 侧 new_id 命名风格一致） */
function newNodeId(): string {
  return `n_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const DEFAULT_NODE_W = 240;

/**
 * BoardCanvas（M2-2 / M2-3 / M2-8）：白板画布 v1
 * - 视口：滚轮缩放（光标锚点不动）、空白拖拽平移
 * - 节点：工具栏「＋新建节点」/ 双击空白 / 右键空白新建；拖拽移动、双击节点改标题、右键节点删除
 * - 命令栈：新建/删除/改标题/拖拽移动均可撤销/重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
 * - 变更通过 onChange 抛给上层做防抖持久化
 */
export function BoardCanvas({
  board,
  onChange,
}: {
  board: BoardFile;
  onChange: (nodes: BoardNode[], viewport: Viewport) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CanvasEngine>(
    new CanvasEngine(board.viewport, { minZoom: 0.2, maxZoom: 3 }),
  );
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  // 节点状态由历史栈驱动（present 即当前节点数组）
  const [history, setHistory] = useState<History<BoardNode[]>>(() => createHistory(board.nodes));
  const nodes = history.present;

  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // 切换白板时重置引擎与历史栈
  useEffect(() => {
    engineRef.current = new CanvasEngine(board.viewport, { minZoom: 0.2, maxZoom: 3 });
    setHistory(createHistory(board.nodes));
    setSelected(null);
    setEditingId(null);
    rerender();
  }, [board.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;

  /** 一次原子变更：记历史 + 落盘 */
  const apply = useCallback(
    (next: BoardNode[]) => {
      setHistory((h) => pushState(h, next));
      onChange(next, engine.viewport);
    },
    [engine, onChange],
  );

  const doUndo = useCallback(() => {
    setHistory((h) => {
      if (!canUndo(h)) return h;
      const nh = histUndo(h);
      onChange(nh.present, engine.viewport);
      return nh;
    });
    setEditingId(null);
  }, [engine, onChange]);

  const doRedo = useCallback(() => {
    setHistory((h) => {
      if (!canRedo(h)) return h;
      const nh = histRedo(h);
      onChange(nh.present, engine.viewport);
      return nh;
    });
    setEditingId(null);
  }, [engine, onChange]);

  /* 撤销/重做快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo]);

  /* ── 拖拽状态（用 ref 避免频繁 setState） ── */
  const drag = useRef<
    | null
    | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
    | { kind: 'node'; id: string; lastX: number; lastY: number; moved: boolean; baseline: BoardNode[] }
  >(null);

  const rect = () => wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };

  /* ── 滚轮缩放：以光标为锚点 ── */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = rect();
    const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
    const factor = Math.exp(-e.deltaY * 0.0015);
    engine.zoomByFactor(anchor, factor);
    rerender();
    onChange(nodes, engine.viewport);
  };

  /* ── 空白按下：平移画布 ── */
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setSelected(null);
    const vp = engine.viewport;
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: vp.x, vy: vp.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /* ── 节点按下：选中 + 准备拖拽（记下拖拽前快照做 baseline） ── */
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(id);
    drag.current = {
      kind: 'node',
      id,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      baseline: nodes,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const vp = engine.viewport;
      engine.setViewport({ ...vp, x: d.vx + (e.clientX - d.startX), y: d.vy + (e.clientY - d.startY) });
      rerender();
    } else {
      const zoom = engine.viewport.zoom;
      const dx = (e.clientX - d.lastX) / zoom;
      const dy = (e.clientY - d.lastY) / zoom;
      if (dx !== 0 || dy !== 0) d.moved = true;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      // 拖拽过程中只 replacePresent，不记历史（松手时一次性提交）
      setHistory((h) =>
        replacePresent(
          h,
          h.present.map((n) => (n.id === d.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
        ),
      );
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.kind === 'pan') {
      onChange(nodes, engine.viewport);
    } else if (d.moved) {
      // 拖动结束：把拖拽前快照补进 past，present 已是最终位置
      setHistory((h) => {
        onChange(h.present, engine.viewport);
        return commitFromBaseline(h, d.baseline);
      });
    }
  };

  /* ── 右键 ── */
  const onCanvasContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = rect();
    const world = engine.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { type: 'item', label: '在此新建节点', onClick: () => addNode(world.x, world.y) },
        { type: 'separator' },
        { type: 'item', label: '撤销  Ctrl+Z', disabled: !canUndo(history), onClick: doUndo },
        { type: 'item', label: '重做  Ctrl+Shift+Z', disabled: !canRedo(history), onClick: doRedo },
      ],
    });
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { type: 'item', label: '编辑标题', onClick: () => setEditingId(id) },
        { type: 'separator' },
        { type: 'item', label: '删除节点', danger: true, onClick: () => removeNode(id) },
      ],
    });
  };

  /** 屏幕坐标 → 世界坐标后新建（右键/双击空白用） */
  const addNodeAtScreen = (clientX: number, clientY: number) => {
    const r = rect();
    const world = engine.toWorld({ x: clientX - r.left, y: clientY - r.top });
    addNode(world.x, world.y);
  };

  const addNode = (x: number, y: number) => {
    const now = new Date().toISOString();
    const node: BoardNode = {
      id: newNodeId(),
      title: '新问题',
      summary: null,
      x: Math.round(x - DEFAULT_NODE_W / 2),
      y: Math.round(y - 20),
      w: DEFAULT_NODE_W,
      color: null,
      docs: [],
      created_at: now,
      updated_at: now,
    };
    apply([...nodes, node]);
    setSelected(node.id);
    setEditingId(node.id);
  };

  const removeNode = (id: string) => {
    apply(nodes.filter((n) => n.id !== id));
    if (selected === id) setSelected(null);
    if (editingId === id) setEditingId(null);
  };

  const commitTitle = (id: string, title: string) => {
    setEditingId(null);
    const t = title.trim();
    const target = nodes.find((n) => n.id === id);
    // 标题没变则不记历史，避免污染撤销栈
    if (!target || (t || '未命名问题') === target.title) return;
    apply(
      nodes.map((n) =>
        n.id === id ? { ...n, title: t || '未命名问题', updated_at: new Date().toISOString() } : n,
      ),
    );
  };

  /* ── 双击空白：新建节点（点在节点上时事件已被节点吞掉，不会触发） ── */
  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.node-card')) return; // 双击节点是改标题，交给 NodeCard
    addNodeAtScreen(e.clientX, e.clientY);
  };

  /* ── 缩放越小、节点热力光越明显（提示此处有节点） ──
     世界层被 scale(zoom) 整体缩放，故光晕的 blur/spread 要除以 zoom 反向补偿，
     让屏幕上看到的光斑随缩小而增强、随放大而消隐。 */
  const zoom = engine.viewport.zoom;
  const intensity = Math.max(0, Math.min(1, (0.85 - zoom) / 0.6)); // zoom 0.85→0，0.25→1
  const glowVars = {
    ['--glow-blur' as string]: `${(20 * intensity) / zoom}px`,
    ['--glow-spread' as string]: `${(3.5 * intensity) / zoom}px`,
    ['--glow-alpha' as string]: `${0.12 + 0.6 * intensity}`,
  } as React.CSSProperties;

  return (
    <div
      ref={wrapRef}
      className="board-canvas board-canvas-live"
      onWheel={onWheel}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onCanvasContextMenu}
      onDoubleClick={onCanvasDoubleClick}
    >
      {/* 悬浮工具栏：撤销 / 重做（始终可见，可点） */}
      <div className="canvas-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tb-btn"
          title="撤销 (Ctrl+Z)"
          disabled={!canUndo(history)}
          onClick={doUndo}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4L2.5 7.2 6 10.4M3 7.2h6.2A4 4 0 0 1 13 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="tb-btn"
          title="重做 (Ctrl+Shift+Z)"
          disabled={!canRedo(history)}
          onClick={doRedo}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 4l3.5 3.2L10 10.4M13 7.2H6.8A4 4 0 0 0 3 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 世界层：只改 transform，不逐个重排节点（DESIGN §5.4） */}
      <div
        className="canvas-world"
        style={{ transform: engine.transform, transformOrigin: '0 0', ...glowVars }}
      >
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            selected={selected === n.id}
            editing={editingId === n.id}
            onPointerDown={onNodePointerDown}
            onDoubleClick={setEditingId}
            onContextMenu={onNodeContextMenu}
            onTitleCommit={commitTitle}
            onEditCancel={() => setEditingId(null)}
          />
        ))}
      </div>

      {nodes.length === 0 && (
        <div className="canvas-empty">
          <p>右键空白处 · 或双击空白处 · 新建第一个问题节点</p>
          <p className="canvas-empty-sub">滚轮缩放 · 拖拽空白平移画布 · Ctrl+Z 撤销</p>
        </div>
      )}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
