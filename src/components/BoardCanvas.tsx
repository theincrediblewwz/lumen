import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { edgeGeometry, straightPath, boxContains, type Box } from '../canvas/geometry';
import type { BoardFile, BoardNode, BoardEdge } from '../api';
import { NodeCard } from './NodeCard';
import { NodeBubble } from './NodeBubble';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

/** 白板图状态：节点 + 连线由同一个历史栈驱动，撤销/重做覆盖两者 */
type Graph = { nodes: BoardNode[]; edges: BoardEdge[] };

function newNodeId(): string {
  return `n_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function newEdgeId(): string {
  return `e_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const DEFAULT_NODE_W = 240;
/** 未测得真实高度前的兜底高度（首帧连线用） */
const FALLBACK_NODE_H = 64;

/**
 * BoardCanvas（M2 + M3）：白板画布
 * - 视口：滚轮缩放（光标锚点不动）、空白拖拽平移
 * - 节点：右键/双击空白新建；拖拽移动、双击改标题、右键删除
 * - 连线（M3）：节点四周锚点拖出 → 落到目标节点建立；贝塞尔曲线 + 箭头 + 端点吸附边框；
 *   选中/删除、有向⇄无向、标签；删除节点级联清理其连线
 * - 命令栈：以上结构变更均可撤销/重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
 */
export function BoardCanvas({
  board,
  onChange,
}: {
  board: BoardFile;
  onChange: (nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CanvasEngine>(
    new CanvasEngine(board.viewport, { minZoom: 0.2, maxZoom: 3 }),
  );
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const [history, setHistory] = useState<History<Graph>>(() =>
    createHistory({ nodes: board.nodes, edges: board.edges ?? [] }),
  );
  const nodes = history.present.nodes;
  const edges = history.present.edges;

  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [bubble, setBubble] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  /** 每个节点测得的真实布局尺寸（世界单位；不随 transform 缩放变化） */
  const sizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const [sizesVer, setSizesVer] = useState(0);
  const onMeasure = useCallback((id: string, w: number, h: number) => {
    const prev = sizesRef.current[id];
    if (!prev || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5) {
      sizesRef.current[id] = { w, h };
      setSizesVer((v) => v + 1);
    }
  }, []);

  // 切换白板时重置引擎、历史栈、测量缓存
  useEffect(() => {
    engineRef.current = new CanvasEngine(board.viewport, { minZoom: 0.2, maxZoom: 3 });
    setHistory(createHistory({ nodes: board.nodes, edges: board.edges ?? [] }));
    sizesRef.current = {};
    setSelected(null);
    setSelectedEdge(null);
    setEditingId(null);
    setEditingEdge(null);
    setBubble(null);
    rerender();
  }, [board.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;

  /** 始终指向最新的图状态：供 window 级拖拽监听读取（避免闭包捕获旧值） */
  const graphRef = useRef(history.present);
  graphRef.current = history.present;

  /** 一次原子变更：记历史 + 落盘 */
  const apply = useCallback(
    (next: Graph) => {
      setHistory((h) => pushState(h, next));
      onChange(next.nodes, next.edges, engine.viewport);
    },
    [engine, onChange],
  );

  const doUndo = useCallback(() => {
    setHistory((h) => {
      if (!canUndo(h)) return h;
      const nh = histUndo(h);
      onChange(nh.present.nodes, nh.present.edges, engine.viewport);
      return nh;
    });
    setEditingId(null);
    setEditingEdge(null);
  }, [engine, onChange]);

  const doRedo = useCallback(() => {
    setHistory((h) => {
      if (!canRedo(h)) return h;
      const nh = histRedo(h);
      onChange(nh.present.nodes, nh.present.edges, engine.viewport);
      return nh;
    });
    setEditingId(null);
    setEditingEdge(null);
  }, [engine, onChange]);

  const removeEdge = useCallback(
    (id: string) => {
      apply({ nodes, edges: edges.filter((e) => e.id !== id) });
      if (selectedEdge === id) setSelectedEdge(null);
      if (editingEdge === id) setEditingEdge(null);
    },
    [apply, nodes, edges, selectedEdge, editingEdge],
  );

  const removeNodeRef = useRef<(id: string) => void>(() => {});

  /* 快捷键：撤销/重做 + Delete 删除选中连线/节点 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          doUndo();
        } else if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault();
          doRedo();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && editingId === null && editingEdge === null) {
        if (selectedEdge) {
          e.preventDefault();
          removeEdge(selectedEdge);
        } else if (selected) {
          e.preventDefault();
          removeNodeRef.current(selected);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, selectedEdge, selected, editingId, editingEdge, removeEdge]);

  /* ── 拖拽状态 ── */
  const drag = useRef<
    | null
    | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
    | { kind: 'node'; id: string; lastX: number; lastY: number; moved: boolean; baseline: Graph }
    | { kind: 'connect'; fromId: string }
  >(null);

  /** 连线拖拽的实时状态（世界坐标）；单独 state 以驱动预览重绘 */
  const [connect, setConnect] = useState<{ fromId: string; to: { x: number; y: number }; hoverId: string | null } | null>(
    null,
  );

  const rect = () => wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };

  const suppressClick = useRef(false);

  /** 取节点世界矩形（用测得尺寸，未测得则兜底） */
  const boxOf = useCallback(
    (n: BoardNode): Box => {
      const s = sizesRef.current[n.id];
      return { x: n.x, y: n.y, w: s?.w ?? n.w ?? DEFAULT_NODE_W, h: s?.h ?? FALLBACK_NODE_H };
    },
    [],
  );

  /* ── 滚轮缩放 ── */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = rect();
    const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
    engine.zoomByFactor(anchor, Math.exp(-e.deltaY * 0.0015));
    rerender();
    onChange(nodes, edges, engine.viewport);
  };

  /* ── 空白按下：平移 ── */
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setSelected(null);
    setSelectedEdge(null);
    setBubble(null);
    const vp = engine.viewport;
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: vp.x, vy: vp.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /* ── 节点按下：选中 + 准备拖拽 ── */
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(id);
    setSelectedEdge(null);
    drag.current = {
      kind: 'node',
      id,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      baseline: history.present,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /* ── 锚点按下：开始拉连线 ──
     锚点元素在拖拽中会因 hover 消失而被卸载、指针捕获也会随之失效，
     故不依赖锚点元素/指针捕获，直接挂 window 级监听全程自算，
     并用 graphRef 读取最新节点/连线（规避闭包旧值）。 */
  const onAnchorPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const b = boxOf(n);
    drag.current = { kind: 'connect', fromId: id };
    setConnect({ fromId: id, to: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, hoverId: null });

    const onMove = (ev: PointerEvent) => {
      const r = rect();
      const world = engine.toWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      let hoverId: string | null = null;
      for (const nn of graphRef.current.nodes) {
        if (nn.id === id) continue;
        if (boxContains(boxOf(nn), world)) {
          hoverId = nn.id;
          break;
        }
      }
      setConnect({ fromId: id, to: world, hoverId });
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      drag.current = null;
      // 用落点重新命中，避免依赖异步 state
      const r = rect();
      const world = engine.toWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      let target: string | null = null;
      for (const nn of graphRef.current.nodes) {
        if (nn.id === id) continue;
        if (boxContains(boxOf(nn), world)) {
          target = nn.id;
          break;
        }
      }
      setConnect(null);
      if (target && target !== id) {
        const curEdges = graphRef.current.edges;
        const dup = curEdges.some(
          (ed) =>
            (ed.from === id && ed.to === target) ||
            (!ed.directed && ed.from === target && ed.to === id),
        );
        if (!dup) {
          const edge: BoardEdge = {
            id: newEdgeId(),
            from: id,
            to: target,
            directed: true,
            label: null,
            created_at: new Date().toISOString(),
          };
          apply({ nodes: graphRef.current.nodes, edges: [...curEdges, edge] });
          setSelectedEdge(edge.id);
          setSelected(null);
        }
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const vp = engine.viewport;
      engine.setViewport({ ...vp, x: d.vx + (e.clientX - d.startX), y: d.vy + (e.clientY - d.startY) });
      rerender();
    } else if (d.kind === 'node') {
      const zoom = engine.viewport.zoom;
      const dx = (e.clientX - d.lastX) / zoom;
      const dy = (e.clientY - d.lastY) / zoom;
      if (dx !== 0 || dy !== 0) d.moved = true;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      setHistory((h) =>
        replacePresent(h, {
          ...h.present,
          nodes: h.present.nodes.map((n) => (n.id === d.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
        }),
      );
    }
    // 'connect' 由 onAnchorPointerDown 里的 window 级监听处理，这里不涉及
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.kind === 'pan') {
      onChange(nodes, edges, engine.viewport);
    } else if (d.kind === 'node') {
      if (d.moved) {
        suppressClick.current = true;
        setHistory((h) => {
          onChange(h.present.nodes, h.present.edges, engine.viewport);
          return commitFromBaseline(h, d.baseline);
        });
      }
    }
    // 'connect' 全程由 onAnchorPointerDown 的 window 监听处理
  };

  /* ── 右键：空白 ── */
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
    setSelectedEdge(null);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { type: 'item', label: '编辑', onClick: () => startEdit(id) },
        { type: 'separator' },
        { type: 'item', label: '删除节点', danger: true, onClick: () => removeNode(id) },
      ],
    });
  };

  const onEdgeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const edge = edges.find((x) => x.id === id);
    if (!edge) return;
    setSelectedEdge(id);
    setSelected(null);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          type: 'item',
          label: edge.directed ? '改为无向（相关）' : '改为有向（追问）',
          onClick: () => toggleEdgeDir(id),
        },
        { type: 'item', label: edge.label ? '编辑标签' : '添加标签', onClick: () => startEdgeLabel(id) },
        { type: 'separator' },
        { type: 'item', label: '删除连线', danger: true, onClick: () => removeEdge(id) },
      ],
    });
  };

  const toggleEdgeDir = (id: string) => {
    apply({
      nodes,
      edges: edges.map((e) => (e.id === id ? { ...e, directed: !e.directed } : e)),
    });
  };

  const startEdgeLabel = (id: string) => {
    setSelectedEdge(id);
    setEditingEdge(id);
  };

  const commitEdgeLabel = (id: string, raw: string) => {
    setEditingEdge(null);
    const edge = edges.find((e) => e.id === id);
    if (!edge) return;
    const label = raw.trim() || null;
    if (label === (edge.label ?? null)) return;
    apply({ nodes, edges: edges.map((e) => (e.id === id ? { ...e, label } : e)) });
  };

  const onEdgeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedEdge(id);
    setSelected(null);
    setBubble(null);
  };

  /* ── 节点气泡 / 编辑 ── */
  const openBubble = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const n = nodes.find((x) => x.id === id);
    const r = rect();
    if (!n) return;
    const scr = engine.toScreen({ x: n.x, y: n.y });
    setBubble({ id, x: r.left + scr.x, y: r.top + scr.y });
  };

  const startEdit = (id: string) => {
    setBubble(null);
    setEditingId(id);
  };

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
    apply({ nodes: [...nodes, node], edges });
    setSelected(node.id);
    setEditingId(node.id);
  };

  const removeNode = (id: string) => {
    // 级联清理该节点的连线（FR-4.5）
    apply({
      nodes: nodes.filter((n) => n.id !== id),
      edges: edges.filter((e) => e.from !== id && e.to !== id),
    });
    if (selected === id) setSelected(null);
    if (editingId === id) setEditingId(null);
    if (bubble?.id === id) setBubble(null);
  };
  removeNodeRef.current = removeNode;

  const commitNode = (id: string, patch: { title?: string; summary?: string }) => {
    const target = nodes.find((n) => n.id === id);
    if (!target) return;
    const nextTitle = patch.title !== undefined ? (patch.title.trim() || '未命名问题') : target.title;
    const nextSummary =
      patch.summary !== undefined ? (patch.summary.trim() || null) : (target.summary ?? null);
    if (nextTitle === target.title && nextSummary === (target.summary ?? null)) return;
    apply({
      nodes: nodes.map((n) =>
        n.id === id
          ? { ...n, title: nextTitle, summary: nextSummary, updated_at: new Date().toISOString() }
          : n,
      ),
      edges,
    });
  };

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.node-card')) return;
    if (t.closest('.edge-hit')) return;
    addNodeAtScreen(e.clientX, e.clientY);
  };

  /* ── 缩放越小、节点热力光越明显 ── */
  const zoom = engine.viewport.zoom;
  const intensity = Math.max(0, Math.min(1, (0.85 - zoom) / 0.6));
  const glowVars = {
    ['--glow-blur' as string]: `${(20 * intensity) / zoom}px`,
    ['--glow-spread' as string]: `${(3.5 * intensity) / zoom}px`,
    ['--glow-alpha' as string]: `${0.12 + 0.6 * intensity}`,
  } as React.CSSProperties;

  /* ── 连线几何 ──
     连线层改为「覆盖整块画布的全尺寸 SVG 覆盖层」，用屏幕坐标绘制。
     原因：SVG 画在 0×0 的世界层里，Chromium/WebView2 常直接不渲染。
     屏幕坐标 = 世界坐标经 engine 变换；故几何需随视口平移/缩放重算，
     用 vpSig 把视口并入 useMemo 依赖。 */
  const nodeById = useMemo(() => {
    const m: Record<string, BoardNode> = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  /** 节点的屏幕坐标包围盒（相对画布容器左上角） */
  const screenBoxOf = useCallback(
    (n: BoardNode): Box => {
      const s = sizesRef.current[n.id];
      const w = s?.w ?? n.w ?? DEFAULT_NODE_W;
      const h = s?.h ?? FALLBACK_NODE_H;
      const tl = engine.toScreen({ x: n.x, y: n.y });
      const z = engine.viewport.zoom;
      return { x: tl.x, y: tl.y, w: w * z, h: h * z };
    },
    [engine],
  );

  const vp = engine.viewport;
  const vpSig = `${vp.x},${vp.y},${vp.zoom}`;

  const laidEdges = useMemo(() => {
    void sizesVer;
    void vpSig;
    return edges
      .map((e) => {
        const a = nodeById[e.from];
        const b = nodeById[e.to];
        if (!a || !b) return null;
        const g = edgeGeometry(screenBoxOf(a), screenBoxOf(b));
        return { edge: e, geo: g };
      })
      .filter((x): x is { edge: BoardEdge; geo: ReturnType<typeof edgeGeometry> } => x !== null);
  }, [edges, nodeById, screenBoxOf, sizesVer, vpSig]);

  // 连线拖拽预览路径（屏幕坐标）
  const connectPreview = useMemo(() => {
    void vpSig;
    if (!connect) return null;
    const a = nodeById[connect.fromId];
    if (!a) return null;
    const from = screenBoxOf(a);
    const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const toScreen = engine.toScreen(connect.to);
    return straightPath(fromCenter, toScreen);
  }, [connect, nodeById, screenBoxOf, engine, vpSig]);


  return (
    <div
      ref={wrapRef}
      className={`board-canvas board-canvas-live${connect ? ' is-connecting' : ''}`}
      onWheel={onWheel}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onCanvasContextMenu}
      onDoubleClick={onCanvasDoubleClick}
    >
      {/* 悬浮工具栏：撤销 / 重做 */}
      <div className="canvas-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="tb-btn" title="撤销 (Ctrl+Z)" disabled={!canUndo(history)} onClick={doUndo}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4L2.5 7.2 6 10.4M3 7.2h6.2A4 4 0 0 1 13 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="tb-btn" title="重做 (Ctrl+Shift+Z)" disabled={!canRedo(history)} onClick={doRedo}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 4l3.5 3.2L10 10.4M13 7.2H6.8A4 4 0 0 0 3 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 连线层：覆盖整块画布的全尺寸 SVG，用屏幕坐标绘制（避免 0×0 世界层不渲染）。
          置于节点层之下（DOM 顺序在前 + CSS 定位），指针默认穿透、仅命中区可点。 */}
      <svg className="edge-layer">
        <defs>
          <marker id="lm-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--edge-color)" />
          </marker>
          <marker id="lm-arrow-sel" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
          </marker>
        </defs>

        {laidEdges.map(({ edge, geo }) => {
          const isSel = selectedEdge === edge.id;
          return (
            <g key={edge.id} className={`edge${isSel ? ' is-selected' : ''}`}>
              {/* 加宽透明命中区 */}
              <path
                className="edge-hit"
                d={geo.d}
                fill="none"
                stroke="transparent"
                strokeWidth={18}
                onClick={(e) => onEdgeClick(e, edge.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEdgeLabel(edge.id);
                }}
                onContextMenu={(e) => onEdgeContextMenu(e, edge.id)}
                onPointerDown={(e) => e.stopPropagation()}
              />
              {/* 可见曲线 */}
              <path
                className="edge-line"
                d={geo.d}
                fill="none"
                markerEnd={edge.directed ? (isSel ? 'url(#lm-arrow-sel)' : 'url(#lm-arrow)') : undefined}
              />
              {edge.label && !editingEdge && (
                <g transform={`translate(${geo.mid.x} ${geo.mid.y})`}>
                  <text className="edge-label" textAnchor="middle" dominantBaseline="central" onDoubleClick={(e) => { e.stopPropagation(); startEdgeLabel(edge.id); }} onPointerDown={(e) => e.stopPropagation()}>
                    {edge.label}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 拖拽预览 */}
        {connectPreview && (
          <path className="edge-preview" d={connectPreview} fill="none" />
        )}
      </svg>

      {/* 世界层：只改 transform（DESIGN §5.4） */}
      <div className="canvas-world" style={{ transform: engine.transform, transformOrigin: '0 0', ...glowVars }}>
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            selected={selected === n.id}
            editing={editingId === n.id}
            showAnchors={(selected === n.id || hoverNode === n.id) && editingId !== n.id}
            connectTarget={connect?.hoverId === n.id}
            onPointerDown={onNodePointerDown}
            onAnchorPointerDown={onAnchorPointerDown}
            onOpen={openBubble}
            onStartEdit={startEdit}
            onContextMenu={onNodeContextMenu}
            onCommit={commitNode}
            onEditCancel={() => setEditingId(null)}
            onExitEdit={() => setEditingId(null)}
            onMeasure={onMeasure}
            onHoverChange={(hovering) => setHoverNode((cur) => (hovering ? n.id : cur === n.id ? null : cur))}
          />
        ))}
      </div>

      {/* 连线标签内联编辑（屏幕坐标浮层） */}
      {editingEdge && (() => {
        const le = laidEdges.find((x) => x.edge.id === editingEdge);
        if (!le) return null;
        const r = rect();
        // geo.mid 已是相对画布容器的屏幕坐标，加容器左上角得视口坐标
        return (
          <input
            className="edge-label-input"
            autoFocus
            defaultValue={le.edge.label ?? ''}
            placeholder="连线标签（如 追问 / 反例 / 应用于）"
            style={{ left: r.left + le.geo.mid.x, top: r.top + le.geo.mid.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdgeLabel(editingEdge, (e.target as HTMLInputElement).value); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditingEdge(null); }
            }}
            onBlur={(e) => commitEdgeLabel(editingEdge, e.target.value)}
          />
        );
      })()}

      {nodes.length === 0 && (
        <div className="canvas-empty">
          <p>右键空白处 · 或双击空白处 · 新建第一个问题节点</p>
          <p className="canvas-empty-sub">拖节点四周的锚点到另一个节点即可连线 · 滚轮缩放 · Ctrl+Z 撤销</p>
        </div>
      )}

      {bubble && (() => {
        const bn = nodes.find((n) => n.id === bubble.id);
        return bn ? (
          <NodeBubble node={bn} anchor={{ x: bubble.x, y: bubble.y }} onClose={() => setBubble(null)} onEdit={startEdit} />
        ) : null;
      })()}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

