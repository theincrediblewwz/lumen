import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasEngine, type Viewport } from '../canvas/CanvasEngine';
import type { BoardFile, BoardNode } from '../api';
import { NodeCard } from './NodeCard';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

/** 生成一个前端本地节点 id（后端保存时沿用；与 Rust 侧 new_id 命名风格一致） */
function newNodeId(): string {
  return `n_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const DEFAULT_NODE_W = 240;

/**
 * BoardCanvas（M2-2 / M2-3）：白板画布 v1
 * - 视口：滚轮缩放（光标锚点不动）、空白拖拽平移
 * - 节点：拖拽移动、右键空白新建、双击编辑标题、右键节点删除
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

  const [nodes, setNodes] = useState<BoardNode[]>(board.nodes);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // 切换白板时重置引擎与本地节点
  useEffect(() => {
    engineRef.current = new CanvasEngine(board.viewport, { minZoom: 0.2, maxZoom: 3 });
    setNodes(board.nodes);
    setSelected(null);
    setEditingId(null);
    rerender();
  }, [board.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;

  const commit = useCallback(
    (next: BoardNode[]) => {
      setNodes(next);
      onChange(next, engine.viewport);
    },
    [engine, onChange],
  );

  /* ── 拖拽状态（用 ref 避免频繁 setState） ── */
  const drag = useRef<
    | null
    | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
    | { kind: 'node'; id: string; lastX: number; lastY: number; moved: boolean }
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

  /* ── 节点按下：选中 + 准备拖拽 ── */
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(id);
    drag.current = { kind: 'node', id, lastX: e.clientX, lastY: e.clientY, moved: false };
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
      setNodes((prev) =>
        prev.map((n) => (n.id === d.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
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
      // 拖动结束落盘（用最新 nodes）
      setNodes((prev) => {
        onChange(prev, engine.viewport);
        return prev;
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
      items: [{ type: 'item', label: '在此新建节点', onClick: () => addNode(world.x, world.y) }],
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
    const next = [...nodes, node];
    commit(next);
    setSelected(node.id);
    setEditingId(node.id);
  };

  const removeNode = (id: string) => {
    commit(nodes.filter((n) => n.id !== id));
    if (selected === id) setSelected(null);
    if (editingId === id) setEditingId(null);
  };

  const commitTitle = (id: string, title: string) => {
    setEditingId(null);
    const t = title.trim();
    commit(nodes.map((n) => (n.id === id ? { ...n, title: t || '未命名问题', updated_at: new Date().toISOString() } : n)));
  };

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
    >
      {/* 世界层：只改 transform，不逐个重排节点（DESIGN §5.4） */}
      <div className="canvas-world" style={{ transform: engine.transform, transformOrigin: '0 0' }}>
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
          <p>空白处右键 · 新建第一个问题节点</p>
          <p className="canvas-empty-sub">滚轮缩放 · 拖拽空白平移画布</p>
        </div>
      )}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
