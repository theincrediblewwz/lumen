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
import { edgeGeometry, straightPath, boxContains, type Box, type EdgeStyle } from '../canvas/geometry';
import { computeTreeLayout } from '../canvas/autoLayout';
import { matchShortcut, isEditableTarget, shortcut } from '../canvas/shortcuts';
import { api, pickMarkdownFiles, type BoardFile, type BoardNode, type BoardEdge, type DocRef } from '../api';
import { openReaderWindow } from '../reader/windowManager';
import { NodeCard } from './NodeCard';
import { NodePanel } from './NodePanel';
import { NodeTooltip } from './NodeTooltip';
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
  edgeStyle = 'curved',
  guessMath = false,
  focusNode = null,
}: {
  board: BoardFile;
  onChange: (nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport) => void;
  edgeStyle?: EdgeStyle;
  guessMath?: boolean;
  /** AI 引用跳转目标（M5-6）：居中并闪烁高亮该节点。nonce 变化即重新触发。 */
  focusNode?: { id: string; nonce: number } | null;
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
  // 供键盘快捷键在稳定回调里读取最新选中与新建节点（规避闭包旧值）
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const addNodeRef = useRef<(x: number, y: number) => void>(() => {});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  /** OS 文件拖放（拖 .md 到节点）悬停命中的节点 id；null 表示未悬停在任何节点上 */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** 正在处理拖入导入（防重入 + 显示忙碌） */
  const [dropBusy, setDropBusy] = useState(false);
  /** AI 跳转高亮：短暂闪烁的节点 id（M5-6） */
  const [flashId, setFlashId] = useState<string | null>(null);
  /** 悬停简介 tooltip：悬停 400ms 后出现 */
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 每个节点测得的真实布局尺寸（世界单位；不随 transform 缩放变化） */
  const sizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const [sizesVer, setSizesVer] = useState(0);
  /** 自动布局归位期间给世界层加过渡类（§4.3：慢 360ms 归位） */
  const [arranging, setArranging] = useState(false);
  const arrangeTimer = useRef<number | null>(null);
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
    setPanelId(null);
    rerender();
  }, [board.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;

  /** 始终指向最新的图状态：供 window 级拖拽监听读取（避免闭包捕获旧值） */
  const graphRef = useRef(history.present);
  graphRef.current = history.present;

  /** OS 文件拖放导入：始终指向最新实现，供只订阅一次的原生拖放监听调用 */
  const importDroppedRef = useRef<(nodeId: string, paths: string[]) => Promise<void>>(async () => {});
  /** 当前拖放命中的节点 id（ref 版，供只订阅一次的监听读取，避免闭包旧值） */
  const dropTargetIdRef = useRef<string | null>(null);
  const setDrop = useCallback((id: string | null) => {
    if (dropTargetIdRef.current !== id) {
      dropTargetIdRef.current = id;
      setDropTargetId(id);
    }
  }, []);

  /** 把一个物理(设备)像素坐标命中到某节点 id（用于原生拖放事件定位） */
  const hitNodeAtPhysical = useCallback(
    (physX: number, physY: number): string | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const dpr = window.devicePixelRatio || 1;
      // 原生拖放坐标是相对窗口的物理像素；转成 CSS 像素后再减去画布容器位置
      const clientX = physX / dpr;
      const clientY = physY / dpr;
      const r = wrap.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
      const world = engineRef.current.toWorld({ x: clientX - r.left, y: clientY - r.top });
      for (const nn of graphRef.current.nodes) {
        const s = sizesRef.current[nn.id];
        const box = { x: nn.x, y: nn.y, w: s?.w ?? nn.w ?? DEFAULT_NODE_W, h: s?.h ?? FALLBACK_NODE_H };
        if (boxContains(box, world)) return nn.id;
      }
      return null;
    },
    [],
  );

  /* ── OS 文件拖放到节点（拖 .md 进来直接嵌入该节点） ──
     用 Tauri 原生 webview 拖放事件（tauri://drag-drop），只订阅一次，逻辑走 ref。 */
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const wv = getCurrentWebview();
        const un = await wv.onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === 'enter' || p.type === 'over') {
            const pos = p.position;
            setDrop(hitNodeAtPhysical(pos.x, pos.y));
          } else if (p.type === 'drop') {
            const pos = p.position;
            const target = hitNodeAtPhysical(pos.x, pos.y);
            setDrop(null);
            if (target && p.paths && p.paths.length > 0) {
              void importDroppedRef.current(target, p.paths);
            }
          } else {
            // leave / cancel
            setDrop(null);
          }
        });
        if (disposed) un();
        else unlisten = un;
      } catch (err) {
        console.error('订阅文件拖放事件失败：', err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      setDrop(null);
    };
  }, [hitNodeAtPhysical, setDrop]);

  // ── AI 引用跳转（M5-6）：居中到目标节点 + 选中 + 闪烁高亮 ──
  useEffect(() => {
    if (!focusNode) return;
    const node = graphRef.current.nodes.find((n) => n.id === focusNode.id);
    const wrap = wrapRef.current;
    if (!node || !wrap) return;
    // 尺寸可能还没测到，用默认宽/估算高兜底
    const size = sizesRef.current[node.id] ?? { w: node.w || 240, h: 120 };
    const rectEl = wrap.getBoundingClientRect();
    // 目标：把节点中心放到视口中心，缩放保持（至少 0.8 以看清）
    const zoom = Math.max(0.8, engine.viewport.zoom);
    const cx = node.x + size.w / 2;
    const cy = node.y + size.h / 2;
    engine.setViewport({
      x: rectEl.width / 2 - cx * zoom,
      y: rectEl.height / 2 - cy * zoom,
      zoom,
    });
    setSelected(node.id);
    setFlashId(node.id);
    rerender();
    onChange(graphRef.current.nodes, graphRef.current.edges, engine.viewport);
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [focusNode?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 一次原子变更：记历史 + 落盘 */
  const apply = useCallback(
    (next: Graph) => {
      setHistory((h) => pushState(h, next));
      onChange(next.nodes, next.edges, engine.viewport);
    },
    [engine, onChange],
  );

  /** 树状自动布局（M6-4）：只重排位置、不改结构，进历史可撤销；带 360ms 归位过渡。 */
  const autoArrange = useCallback(() => {
    const g = graphRef.current;
    if (g.nodes.length === 0) return;
    // 用节点原坐标包围盒左上作为布局原点，避免整块图跳到别处
    const minX = Math.min(...g.nodes.map((n) => n.x));
    const minY = Math.min(...g.nodes.map((n) => n.y));
    const layoutNodes = g.nodes.map((n) => ({
      id: n.id,
      w: sizesRef.current[n.id]?.w ?? n.w ?? 240,
      h: sizesRef.current[n.id]?.h ?? 96,
    }));
    const pos = computeTreeLayout(layoutNodes, g.edges, {
      originX: minX,
      originY: minY,
    });
    const nextNodes = g.nodes.map((n) => {
      const p = pos.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
    // 先开启过渡类，再更新坐标，让节点平滑滑到新位；到时长后移除类
    setArranging(true);
    if (arrangeTimer.current) window.clearTimeout(arrangeTimer.current);
    arrangeTimer.current = window.setTimeout(() => setArranging(false), 420);
    apply({ nodes: nextNodes, edges: g.edges });
  }, [apply]);

  /* ── 键盘视图操作（M6-9）：缩放 / 重置 / 适配 / 中心新建 / 微移 ── */

  /** 以视口中心为锚缩放（键盘缩放不该跟着鼠标跑）。 */
  const zoomCenter = useCallback(
    (factor: number) => {
      const r = rect();
      engine.zoomByFactor({ x: r.width / 2, y: r.height / 2 }, factor);
      rerender();
      onChange(graphRef.current.nodes, graphRef.current.edges, engine.viewport);
    },
    [engine, onChange, rerender],
  );

  /** 缩放重置为 100%，保持视口中心对应的世界点不动。 */
  const zoomReset = useCallback(() => {
    const r = rect();
    engine.zoomAtPoint({ x: r.width / 2, y: r.height / 2 }, 1);
    rerender();
    onChange(graphRef.current.nodes, graphRef.current.edges, engine.viewport);
  }, [engine, onChange, rerender]);

  /** 适配全部内容到屏幕（zoom-to-fit）。 */
  const fitAll = useCallback(() => {
    const g = graphRef.current;
    const r = rect();
    if (g.nodes.length === 0) {
      engine.fit(null, { width: r.width, height: r.height });
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of g.nodes) {
        const s = sizesRef.current[n.id] ?? { w: n.w || 240, h: 96 };
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + s.w);
        maxY = Math.max(maxY, n.y + s.h);
      }
      engine.fit(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        { width: r.width, height: r.height },
      );
    }
    rerender();
    onChange(graphRef.current.nodes, graphRef.current.edges, engine.viewport);
  }, [engine, onChange, rerender]);

  /** 在视口中心新建节点（键盘 N）。 */
  const addNodeAtCenter = useCallback(() => {
    const r = rect();
    const world = engine.toWorld({ x: r.width / 2, y: r.height / 2 });
    addNodeRef.current(world.x, world.y);
  }, [engine]);

  /** 方向键微移选中节点（Shift 步长更大），进历史可撤销。 */
  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      const id = selectedRef.current;
      if (!id) return;
      const g = graphRef.current;
      const nextNodes = g.nodes.map((n) =>
        n.id === id
          ? { ...n, x: n.x + dx, y: n.y + dy, updated_at: new Date().toISOString() }
          : n,
      );
      apply({ nodes: nextNodes, edges: g.edges });
    },
    [apply],
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

  /* 快捷键（M6-9，集中匹配）：撤销/重做/缩放/适配/新建/微移/删除/取消 */
  useEffect(() => {
    const hit = (id: string, e: KeyboardEvent) => matchShortcut(e, shortcut(id)!);
    const onKey = (e: KeyboardEvent) => {
      // 撤销/重做即便焦点在输入框外也应响应；但打字时交给输入框自身
      const editable = isEditableTarget(e.target);
      if (!editable) {
        if (hit('undo', e)) {
          e.preventDefault();
          doUndo();
          return;
        }
        if (hit('redo', e)) {
          e.preventDefault();
          doRedo();
          return;
        }
        if (hit('zoom-in', e)) {
          e.preventDefault();
          zoomCenter(1.2);
          return;
        }
        if (hit('zoom-out', e)) {
          e.preventDefault();
          zoomCenter(1 / 1.2);
          return;
        }
        if (hit('zoom-reset', e)) {
          e.preventDefault();
          zoomReset();
          return;
        }
        if (hit('fit', e)) {
          e.preventDefault();
          fitAll();
          return;
        }
        if (hit('new-node', e)) {
          e.preventDefault();
          addNodeAtCenter();
          return;
        }
      }

      // 以下画布级操作在打字时一律跳过（避免删节点等误操作）
      if (editable) return;

      if (e.key === 'Escape') {
        if (panelId) {
          e.preventDefault();
          setPanelId(null);
        } else if (selected || selectedEdge) {
          e.preventDefault();
          setSelected(null);
          setSelectedEdge(null);
        }
        return;
      }

      // 方向键微移选中节点（Shift 步长更大）
      if (
        selectedRef.current &&
        editingId === null &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 2;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        nudgeSelected(dx, dy);
        return;
      }

      if (hit('delete', e) && editingId === null && editingEdge === null) {
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
  }, [
    doUndo,
    doRedo,
    zoomCenter,
    zoomReset,
    fitAll,
    addNodeAtCenter,
    nudgeSelected,
    selectedEdge,
    selected,
    editingId,
    editingEdge,
    removeEdge,
    panelId,
  ]);

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
    setPanelId(null);
    clearTip();
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
    setPanelId(id); // 打开内容面板（编辑在面板里完成，右键不再单列「编辑」）
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
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
    setPanelId(null);
  };

  /* ── 点击节点：选中并在右侧打开内容面板（NodePanel） ── */
  const openPanel = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setSelected(id);
    setSelectedEdge(null);
    setPanelId(id);
  };

  const startEdit = (id: string) => {
    setEditingId(id);
  };

  /* ── 悬停简介 tooltip（400ms 延时） ── */
  const clearTip = useCallback(() => {
    if (tipTimer.current) {
      clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
    setTip(null);
  }, []);

  const onNodeHover = useCallback(
    (id: string, hovering: boolean, clientX: number, clientY: number) => {
      setHoverNode((cur) => (hovering ? id : cur === id ? null : cur));
      if (!hovering) {
        clearTip();
        return;
      }
      // 编辑中 / 已在面板里看该节点 / 正在拖拽时不弹 tooltip
      if (editingId || panelId === id || drag.current) return;
      if (tipTimer.current) clearTimeout(tipTimer.current);
      tipTimer.current = setTimeout(() => setTip({ id, x: clientX, y: clientY }), 400);
    },
    [clearTip, editingId, panelId],
  );

  /** 设置节点颜色标记 */
  const setNodeColor = (id: string, color: string | null) => {
    const target = nodes.find((n) => n.id === id);
    if (!target || (target.color ?? null) === color) return;
    apply({
      nodes: nodes.map((n) =>
        n.id === id ? { ...n, color, updated_at: new Date().toISOString() } : n,
      ),
      edges,
    });
  };

  /* ── 文档：导入 / 打开阅读 / 移除（M4-3 / M4-4） ── */
  const attachDocs = (nodeId: string, refs: DocRef[]) => {
    if (refs.length === 0) return;
    const g = graphRef.current;
    apply({
      nodes: g.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              // 去重（按 path），追加新导入的文档
              docs: [...n.docs.filter((d) => !refs.some((r) => r.path === d.path)), ...refs],
              updated_at: new Date().toISOString(),
            }
          : n,
      ),
      edges: g.edges,
    });
  };

  /** 把一组绝对路径的文档复制进白板 docs/ 并挂到节点（去重、逐个导入，返回成功导入数） */
  const importPathsToNode = async (nodeId: string, paths: string[]): Promise<number> => {
    if (paths.length === 0) return 0;
    const refs: DocRef[] = [];
    const failed: string[] = [];
    for (const p of paths) {
      try {
        refs.push(await api.docImport(board.projectId, board.id, p));
      } catch (err) {
        console.error('导入文档失败：', p, err);
        failed.push(p);
      }
    }
    attachDocs(nodeId, refs);
    if (failed.length > 0) {
      alert(`有 ${failed.length} 个文件导入失败（仅支持 .md / .markdown）：\n${failed.join('\n')}`);
    }
    return refs.length;
  };

  const importDocs = async (nodeId: string) => {
    try {
      const paths = await pickMarkdownFiles();
      await importPathsToNode(nodeId, paths);
    } catch (err) {
      console.error('导入文档失败：', err);
      alert(`导入文档失败：${String(err)}`);
    }
  };

  /** OS 文件拖放到节点：过滤 .md/.markdown，导入并挂到该节点，并短暂高亮 */
  const importDroppedToNode = async (nodeId: string, paths: string[]) => {
    const mdPaths = paths.filter((p) => /\.(md|markdown)$/i.test(p));
    if (mdPaths.length === 0) {
      alert('只能拖入 Markdown 文件（.md / .markdown）。');
      return;
    }
    setDropBusy(true);
    try {
      const n = await importPathsToNode(nodeId, mdPaths);
      if (n > 0) {
        setSelected(nodeId);
        setFlashId(nodeId);
        window.setTimeout(() => setFlashId(null), 1200);
      }
    } finally {
      setDropBusy(false);
    }
  };
  importDroppedRef.current = importDroppedToNode;

  const openDoc = (_nodeId: string, path: string, title: string) => {
    void openReaderWindow({ projectId: board.projectId, boardId: board.id, path, title });
  };

  const removeDoc = async (nodeId: string, path: string) => {
    try {
      await api.docDelete(board.projectId, board.id, path);
    } catch (err) {
      console.error('删除文档文件失败（仍从节点解除关联）：', err);
    }
    const g = graphRef.current;
    apply({
      nodes: g.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, docs: n.docs.filter((d) => d.path !== path), updated_at: new Date().toISOString() }
          : n,
      ),
      edges: g.edges,
    });
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
    const g = graphRef.current;
    apply({ nodes: [...g.nodes, node], edges: g.edges });
    setSelected(node.id);
    setEditingId(node.id);
  };
  addNodeRef.current = addNode;

  const removeNode = (id: string) => {
    // 级联清理该节点的连线（FR-4.5）
    apply({
      nodes: nodes.filter((n) => n.id !== id),
      edges: edges.filter((e) => e.from !== id && e.to !== id),
    });
    if (selected === id) setSelected(null);
    if (editingId === id) setEditingId(null);
    if (panelId === id) setPanelId(null);
    clearTip();
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
        const g = edgeGeometry(screenBoxOf(a), screenBoxOf(b), edgeStyle);
        return { edge: e, geo: g };
      })
      .filter((x): x is { edge: BoardEdge; geo: ReturnType<typeof edgeGeometry> } => x !== null);
  }, [edges, nodeById, screenBoxOf, sizesVer, vpSig, edgeStyle]);

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
      {/* 悬浮工具栏：撤销 / 重做 / 整理 / 缩放 / 适配 */}
      <div className="canvas-toolbar" role="toolbar" aria-label="画布工具" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="tb-btn" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!canUndo(history)} onClick={doUndo}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4L2.5 7.2 6 10.4M3 7.2h6.2A4 4 0 0 1 13 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="tb-btn" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!canRedo(history)} onClick={doRedo}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 4l3.5 3.2L10 10.4M13 7.2H6.8A4 4 0 0 0 3 11.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="tb-sep" aria-hidden="true" />
        <button type="button" className="tb-btn" title="整理布局（树状自动排列，可撤销）" aria-label="整理布局" disabled={nodes.length === 0} onClick={autoArrange}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="6" y="1.5" width="4" height="3" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="1.5" y="11.5" width="4" height="3" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="10.5" y="11.5" width="4" height="3" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4.5v3M8 7.5H3.5v4M8 7.5h4.5v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="tb-sep" aria-hidden="true" />
        <button type="button" className="tb-btn" title="缩小 (Ctrl+-)" aria-label="缩小" onClick={() => zoomCenter(1 / 1.2)}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="tb-btn tb-zoom" title="缩放重置为 100% (Ctrl+0)" aria-label={`当前缩放 ${Math.round(zoom * 100)}%，点击重置为 100%`} onClick={zoomReset}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="tb-btn" title="放大 (Ctrl+=)" aria-label="放大" onClick={() => zoomCenter(1.2)}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="tb-btn" title="适配全部内容 (Shift+1)" aria-label="适配全部内容到屏幕" onClick={fitAll}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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
                pathLength={1}
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
      <div className={`canvas-world${arranging ? ' is-arranging' : ''}`} style={{ transform: engine.transform, transformOrigin: '0 0', ...glowVars }}>
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            selected={selected === n.id}
            flash={flashId === n.id}
            editing={editingId === n.id}
            showAnchors={(selected === n.id || hoverNode === n.id) && editingId !== n.id}
            connectTarget={connect?.hoverId === n.id}
            dropTarget={dropTargetId === n.id}
            onPointerDown={onNodePointerDown}
            onAnchorPointerDown={onAnchorPointerDown}
            onOpen={openPanel}
            onStartEdit={startEdit}
            onContextMenu={onNodeContextMenu}
            onCommit={commitNode}
            onEditCancel={() => setEditingId(null)}
            onExitEdit={() => setEditingId(null)}
            onMeasure={onMeasure}
            onHoverChange={(hovering, cx, cy) => onNodeHover(n.id, hovering, cx, cy)}
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

      {/* 文件拖放提示：拖 .md 悬停在节点上时给出「松开嵌入」引导 */}
      {dropTargetId && (
        <div className="drop-hint" role="status">松开鼠标，把文档嵌入该节点</div>
      )}
      {dropBusy && <div className="drop-hint drop-hint-busy" role="status">正在导入文档…</div>}

      {/* 悬停简介 tooltip（不拦截指针） */}
      {tip && !panelId && (() => {
        const tn = nodes.find((n) => n.id === tip.id);
        return tn ? <NodeTooltip node={tn} x={tip.x} y={tip.y} /> : null;
      })()}

      {/* 节点内容面板（选中节点后停靠右侧） */}
      {panelId && (() => {
        const pn = nodes.find((n) => n.id === panelId);
        return pn ? (
          <NodePanel
            node={pn}
            onCommit={commitNode}
            onColor={setNodeColor}
            onDelete={removeNode}
            onClose={() => setPanelId(null)}
            onOpenDoc={openDoc}
            onImportDocs={importDocs}
            onRemoveDoc={removeDoc}
            projectId={board.projectId}
            boardId={board.id}
            guessMath={guessMath}
          />
        ) : null;
      })()}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}










