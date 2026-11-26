import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Focus, Move, X } from 'lucide-react';
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
import { nearStraightLine, straightPath, boxContains, type Box } from '../canvas/geometry';
import { computeTreeLayout } from '../canvas/autoLayout';
import {routeBoardEdges,edgeLabelLines} from '../canvas/edgeRouting';
import { descendantIds,translateFromBaseline } from '../canvas/subtree';
import { matchShortcut, isEditableTarget, shortcut } from '../canvas/shortcuts';
import { dropPointToClient, detectMacOS } from '../canvas/dropPoint';
import { pickMarkdownFiles, type BoardFile, type BoardNode, type BoardEdge } from '../api';
import { openReaderWindow } from '../reader/windowManager';
import {attachDocument,stickerDimensions} from '../documents/client';
import { api, type DocRef } from '../api';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { loadWritePolicy } from '../ai/boardOperations';
import { MIN_BOARD_ZOOM, boardAppearance, FONT_FAMILIES, heatLevel, aggregateHeat, intersects, snapConnection, resizedBox, resizedImageBox, questionPath, type BoardAppearance } from '../canvas/presentation';
import { boardImageSizing, imageDisplayAt, type ImagePixels } from '../canvas/imageSizing';
import { DocumentEditor } from './DocumentEditor';
import { QuestionEditor } from './QuestionEditor';
import { BoardAppearancePanel } from './BoardAppearancePanel';
import { NodeCard, type PreviewImage } from './NodeCard';
import { NodePanel } from './NodePanel';
import { NodeTooltip } from './NodeTooltip';
import { EdgeLabel } from './EdgeLabel';
import { FlowPanel } from './FlowPanel';
import { BranchFocusView } from './BranchFocusView';
import { TitleBarButton } from './TitleBarButton';
import { contentDocs, imageDoc, imageOnly, clipboardText, nonemptyNode, flowNodes, orderFlow, topLevelNodes } from '../canvas/composition';
import { measureNodes } from '../canvas/measureNodes';
import { flowHighlight } from '../canvas/preview';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { assignedTags, colorTag, type CatalogTag, type TagStore } from '../projectCanvas/tags';

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
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
type DocumentNotice = { text: string; autoDismiss: boolean; fading?: boolean };

/**
 * BoardCanvas（M2 + M3）：白板画布
 * - 视口：滚轮缩放（光标锚点不动）、空白拖拽平移
 * - 节点：右键/双击空白新建；拖拽移动、双击改标题、右键删除
 * - 连线（M3）：节点四周锚点拖出 → 落到目标节点建立；直线、手动弯折、箭头与端点吸附边框；
 *   选中/删除、有向⇄无向、标签；删除节点级联清理其连线
 * - 命令栈：以上结构变更均可撤销/重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
 */
export function BoardCanvas({
  board, scope, syncMutationLock,
  onChange, onViewportChange, onFlush, saveState,
  guessMath = false,
  focusNode = null,
  actionSlot, onBranchFocusChange, fullscreen,
  tags, tagStore, tagFilter, onEditTags,
}: {
  onFlush:()=>Promise<void>; saveState:'saved'|'dirty'|'saving'|'error';
  board: BoardFile;
  scope: string;
  syncMutationLock: { readonly current: boolean };
  onChange: (nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport, appearance?:BoardAppearance) => void;
  onViewportChange: (viewport: Viewport) => void;
  guessMath?: boolean;
  /** AI 引用跳转目标（M5-6）：居中并闪烁高亮该节点。nonce 变化即重新触发。 */
  focusNode?: { id: string; nonce: number } | null;
  actionSlot: HTMLElement | null;
  onBranchFocusChange: (active: boolean) => void;
  fullscreen: boolean;
  tags: CatalogTag[];
  tagStore?: TagStore;
  tagFilter: ReadonlySet<string>;
  onEditTags: (node: BoardNode) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const focusToggle = useRef<HTMLButtonElement>(null);
  const [quickMove, setQuickMove] = useState(false);
  const [branchRoot, setBranchRoot] = useState<string | null>(null);
  const branchRootRef = useRef<string | null>(null);
  const setBranchFocus = useCallback((id: string | null) => {
    branchRootRef.current = id;
    setBranchRoot(id);
    onBranchFocusChange(id !== null);
  }, [onBranchFocusChange]);
  useEffect(() => () => onBranchFocusChange(false), [onBranchFocusChange]);
  useLayoutEffect(() => {
    if (wrapRef.current) wrapRef.current.inert = branchRoot !== null;
  }, [branchRoot]);
  const mutationsBlocked = useCallback(() => syncMutationLock.current || !!document.querySelector('[aria-modal="true"]'), [syncMutationLock]);
  const engineRef = useRef<CanvasEngine>(
    new CanvasEngine(board.viewport, { minZoom: MIN_BOARD_ZOOM, maxZoom: 3 }),
  );
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);
  const paintFrame = useRef<number | null>(null);
  const scheduleViewportPaint = useCallback(() => {
    if (paintFrame.current !== null) return;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      rerender();
    });
  }, [rerender]);
  useEffect(() => () => {
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    paintFrame.current = null;
  }, [board.id]);

  const [history, setHistory] = useState<History<Graph>>(() =>
    createHistory({ nodes: board.nodes, edges: board.edges ?? [] }),
  );
  const nodes = history.present.nodes;
  const edges = history.present.edges;
  const imageSizing = useMemo(() => boardImageSizing(scope, board.projectId, board.id,
    path => stickerDimensions(board.projectId, board.id, path)), [scope, board.projectId, board.id]);
  const matches = useMemo(() => {
    if (!tagFilter.size) return null;
    const matched = new Set<string>();
    const entrances = new Set<string>();
    for (const node of nodes) {
      const legacy = colorTag(node.color);
      const labels = assignedTags(tagStore, { kind: 'node', projectId: board.projectId, boardId: board.id, id: node.id });
      if (labels.some(id => tagFilter.has(id)) || (legacy && tagFilter.has(legacy))) {
        matched.add(node.id);
        if (node.flowOwnerId) entrances.add(node.flowOwnerId);
      }
    }
    return { matched, entrances };
  }, [nodes, tagFilter, tagStore, board.projectId, board.id]);
  const mainNodes = useMemo(() => topLevelNodes(nodes).filter(node =>
    !matches || matches.matched.has(node.id) || matches.entrances.has(node.id)), [nodes, matches]);
  const mainIds=useMemo(()=>new Set(mainNodes.map(n=>n.id)),[mainNodes]);
  const mainIdsRef = useRef(mainIds);
  mainIdsRef.current = mainIds;
  const mainEdges=useMemo(()=>edges.filter(e=>mainIds.has(e.from)&&mainIds.has(e.to)),[edges,mainIds]);
  const historyRef = useRef(history);
  historyRef.current = history;

  const [selected, setSelected] = useState<string | null>(null);
  const edgeRouteCleanup=useRef<(()=>void)|null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // 供键盘快捷键在稳定回调里读取最新选中与新建节点（规避闭包旧值）
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const addNodeRef = useRef<(x: number, y: number) => void>(() => {});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [appearanceOpen,setAppearanceOpen]=useState(false);
  const [docVersions,setDocVersions]=useState<Record<string,number>>({});
  const [documentEditor,setDocumentEditor]=useState<{nodeId:string;path:string;title:string;kind?:'question'}>();
  const [canvasSize,setCanvasSize]=useState({width:1280,height:800});
  useEffect(()=>{const el=wrapRef.current;if(!el)return;const report=()=>setCanvasSize({width:el.clientWidth,height:el.clientHeight});report();const observer=new ResizeObserver(report);observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{const show=(e:Event)=>{if((e as CustomEvent).detail===board.id)setAppearanceOpen(v=>!v);};window.addEventListener('lumen:board-settings',show);return()=>window.removeEventListener('lumen:board-settings',show);},[board.id]);
  const appearance=boardAppearance(board.appearance);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [flowOwnerId,setFlowOwnerId]=useState<string|null>(null);
  const pasteTarget=useRef<string|null>(null),pasteFlow=useRef<string|null>(null);
  const arrangeJob=useRef<AbortController|null>(null);
  const [arrangeBusy,setArrangeBusy]=useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [moveRoot,setMoveRoot]=useState<string|null>(null);
  const [moveIds,setMoveIds]=useState<Set<string>>(new Set());
  const [draggingNodes,setDraggingNodes]=useState(false);
  /** 面板当前对应的节点（ref 版）：原生拖放监听只订阅一次，需要读最新值 */
  const panelIdRef = useRef<string | null>(null);
  panelIdRef.current = panelId;
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  useEffect(() => {
    if (!matches) return;
    const visible = (id: string) => matches.matched.has(id) || matches.entrances.has(id);
    if (selected && !visible(selected)) setSelected(null);
    if (panelId && !visible(panelId)) setPanelId(null);
    if (flowOwnerId && !visible(flowOwnerId)) setFlowOwnerId(null);
    if (hoverNode && !visible(hoverNode)) setHoverNode(null);
  }, [matches, selected, panelId, flowOwnerId, hoverNode]);
  /** OS 文件拖放（拖 .md 到节点）悬停命中的节点 id；null 表示未悬停在任何节点上 */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** 正在处理拖入导入（防重入 + 显示忙碌） */
  const [dropBusy, setDropBusy] = useState(false);
  const [notice, setNotice] = useState<DocumentNotice | null>(null);
  const setDocumentStatus = useCallback((text: string, autoDismiss = false) => {
    setNotice(text ? { text, autoDismiss } : null);
  }, []);
  const documentStatus = notice?.text;
  useEffect(() => {
    if (!notice?.autoDismiss || dropBusy) return;
    const timer = window.setTimeout(() => {
      setNotice(current => current !== notice ? current : notice.fading ? null : { ...notice, fading: true });
    }, notice.fading ? 220 : 3000);
    return () => window.clearTimeout(timer);
  }, [notice, dropBusy]);
  const documentImport=useRef<AbortController|null>(null);
  const imageJobs=useRef(0);
  const mounted=useRef(true);
  const documentBoard=useRef(`${board.projectId}/${board.id}`);documentBoard.current=`${board.projectId}/${board.id}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;documentImport.current?.abort();};},[]);
  useEffect(()=>()=>{documentImport.current?.abort();},[board.id]);
  /** AI 跳转高亮：短暂闪烁的节点 id（M5-6） */
  const [flashId, setFlashId] = useState<string | null>(null);
  /** 悬停简介 tooltip：悬停 400ms 后出现 */
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTip = useCallback(() => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
  }, []);

  /** 每个节点测得的真实布局尺寸（世界单位；不随 transform 缩放变化） */
  const sizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const minimumRef=useRef<Record<string,{w:number;h:number}>>({});
  const [sizesVer, setSizesVer] = useState(0);
  /** 自动布局归位期间给世界层加过渡类（§4.3：慢 360ms 归位） */
  const [arranging, setArranging] = useState(false);
  const arrangeTimer = useRef<number | null>(null);
  const onMeasure = useCallback((id: string, w: number, h: number, minimumW=120, minimumH=64) => {
    minimumRef.current[id]={w:minimumW,h:minimumH};
    const prev = sizesRef.current[id];
    if (!prev || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5) {
      sizesRef.current[id] = { w, h };
      setSizesVer((v) => v + 1);
    }
  }, []);

  // 切换白板时重置引擎、历史栈、测量缓存
  useEffect(() => {
    engineRef.current = new CanvasEngine(board.viewport, { minZoom: MIN_BOARD_ZOOM, maxZoom: 3 });
    setHistory(createHistory({ nodes: board.nodes, edges: board.edges ?? [] }));
    sizesRef.current = {};minimumRef.current={};setFlowOwnerId(null);
    setSelected(null);
    setSelectedEdge(null);
    setEditingId(null);
    setEditingEdge(null);
    setPanelId(null);
    setMoveRoot(null);drag.current=null;setDraggingNodes(false);
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

  /**
   * 原生拖放坐标 → 命中的节点 id（拖 .md 到节点、或拖到「问题节点面板」上时用）。
   *
   * ⚠ 平台坐标口径不一致（已核对本机 tauri 2.11.5 / wry 0.55.1 源码）：
   *   - Windows：wry/webview2 先 ScreenToClient(pt) 再上报 → **物理像素**
   *     （webview2/drag_drop.rs:167,184  position: (pt.x, pt.y)）
   *   - macOS  ：wry/wkwebview 用 NSPoint/NSRect 算 (x, frame.height - y) → **逻辑点**
   *     （wkwebview/drag_drop.rs:42）
   *   两边到 tauri-runtime-wry 都被原样包成 `PhysicalPosition` 且不做缩放
   *   （lib.rs:4872），契约上却声明为物理像素（tauri-runtime/window.rs:103）。
   *   于是 macOS 上再除一次 devicePixelRatio 就会把坐标砍半（Retina dpr=2），
   *   命中测试全部落空 —— 症状正是「Mac 上拖文件没反应，Windows 却正常」。
   */
  const hitNodeAtPhysical = useCallback((rawX: number, rawY: number): string | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    // 平台口径差异与兜底都收敛在 dropPoint（纯逻辑，src/canvas/dropPoint.test.ts 有覆盖）
    const { x: clientX, y: clientY } = dropPointToClient(rawX, rawY, {
      isMac: detectMacOS(),
      dpr: window.devicePixelRatio || 1,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    });

    const r = wrap.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const front=document.elementFromPoint(clientX,clientY) as HTMLElement|null;
    if(front?.closest('.node-panel'))return panelIdRef.current;
    const card=front?.closest<HTMLElement>('[data-node-id]');if(card&&graphRef.current.nodes.some(n=>n.id===card.dataset.nodeId))return card.dataset.nodeId!;
    if(front?.closest('.flow-panel'))return null;
    const world = engineRef.current.toWorld({ x: clientX - r.left, y: clientY - r.top });
    for (const nn of topLevelNodes(graphRef.current.nodes)) {
      if (!mainIdsRef.current.has(nn.id)) continue;
      const s = sizesRef.current[nn.id];
      const box = { x: nn.x, y: nn.y, w: Math.max(nn.w??DEFAULT_NODE_W,s?.w??0), h:Math.max(nn.h??0,s?.h??FALLBACK_NODE_H) };
      if (boxContains(box, world)) return nn.id;
    }
    return null;
  }, []);

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
          if (branchRootRef.current) return;
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
            } else if(!target&&p.paths){const wrap=wrapRef.current?.getBoundingClientRect();if(wrap){const client=dropPointToClient(pos.x,pos.y,{isMac:detectMacOS(),dpr:window.devicePixelRatio||1,viewportW:window.innerWidth,viewportH:window.innerHeight});const at=engineRef.current.toWorld({x:client.x-wrap.left,y:client.y-wrap.top});const over=document.elementFromPoint(client.x,client.y) as HTMLElement|null;void importBlank.current(p.paths,at,over?.closest<HTMLElement>('[data-flow-owner]')?.dataset.flowOwner??null);}}
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
    if (branchRootRef.current) setBranchFocus(null);
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
    onViewportChange(engine.viewport);
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [focusNode?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 一次原子变更：记历史 + 落盘 */
  const apply = useCallback(
    (next: Graph) => {
      // Native attachment completion releases the lock before this callback;
      // React may still be painting the old overlay. Adopt committed data even
      // when another modal is open; user input is isolated by the key handler.
      if (syncMutationLock.current) return;
      const active=drag.current;
      if(active?.kind==='node'){
        // An asynchronous document attachment is a separate change. Cancel only
        // the drag coordinates, preserving new document/content fields.
        const original=replacePresent(historyRef.current,{...historyRef.current.present,nodes:translateFromBaseline(historyRef.current.present.nodes,active.positions,0,0)});
        historyRef.current=original;graphRef.current=original.present;setHistory(original);
        next={...next,nodes:translateFromBaseline(next.nodes,active.positions,0,0)};
        drag.current=null;setDraggingNodes(false);suppressClick.current=true;
      }
      setMoveRoot(null);
      const nextHistory=pushState(historyRef.current,next);historyRef.current=nextHistory;graphRef.current=next;setHistory(nextHistory);
      onChange(next.nodes, next.edges, engine.viewport);
    },
    [engine, onChange, syncMutationLock],
  );

  /** 树状自动布局（M6-4）：只重排位置、不改结构，进历史可撤销；带 360ms 归位过渡。 */
  const autoArrange = useCallback(async () => {
    if(drag.current||arrangeJob.current||!wrapRef.current)return;
    const snapshot=historyRef.current.present,visible=topLevelNodes(snapshot.nodes);if(!visible.length)return;
    const controller=new AbortController();arrangeJob.current=controller;setArrangeBusy(true);
    try {
      const sizes=await measureNodes(wrapRef.current,visible,board.projectId,board.id,controller.signal,done=>setDocumentStatus(`正在适配内容 ${done}/${visible.length}`));
      if(controller.signal.aborted||historyRef.current.present!==snapshot)throw Error('整理期间内容发生变化，原布局保留，请重试');
      const layout=visible.map(n=>({id:n.id,...sizes.get(n.id)!})),ids=new Set(visible.map(n=>n.id));
      const origin=visible.reduce((at,n)=>({originX:Math.min(at.originX,n.x),originY:Math.min(at.originY,n.y)}),{originX:Infinity,originY:Infinity});
      const positions=computeTreeLayout(layout,snapshot.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),origin);
      setArranging(true);if(arrangeTimer.current)window.clearTimeout(arrangeTimer.current);arrangeTimer.current=window.setTimeout(()=>setArranging(false),420);
      apply({nodes:snapshot.nodes.map(n=>positions.has(n.id)?{...n,...positions.get(n.id),...sizes.get(n.id)}:n),edges:snapshot.edges});setDocumentStatus('已适配全部节点内容并整理布局');
    } catch(error){if(mounted.current)setDocumentStatus(String(error));}
    finally{arrangeJob.current=null;if(mounted.current)setArrangeBusy(false);}
  }, [apply,board.projectId,board.id]);

  /* ── 键盘视图操作（M6-9）：缩放 / 重置 / 适配 / 中心新建 / 微移 ── */

  /** 以视口中心为锚缩放（键盘缩放不该跟着鼠标跑）。 */
  const zoomCenter = useCallback(
    (factor: number) => {
      if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
      const r = rect();
      engine.zoomByFactor({ x: r.width / 2, y: r.height / 2 }, factor);
      rerender();
      onViewportChange(engine.viewport);
    },
    [engine, onViewportChange, rerender],
  );

  /** 缩放重置为 100%，保持视口中心对应的世界点不动。 */
  const zoomReset = useCallback(() => {
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    const r = rect();
    engine.zoomAtPoint({ x: r.width / 2, y: r.height / 2 }, 1);
    rerender();
    onViewportChange(engine.viewport);
  }, [engine, onViewportChange, rerender]);

  /** 适配全部内容到屏幕（zoom-to-fit）。 */
  const fitAll = useCallback(() => {
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    const whole=graphRef.current,ids=mainIdsRef.current,shown=whole.nodes.filter(node=>ids.has(node.id));
    const g={nodes:shown,edges:whole.edges.filter(e=>ids.has(e.from)&&ids.has(e.to))};
    const r = rect();
    if (g.nodes.length === 0) {
      engine.fit(null, { width: r.width, height: r.height });
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of g.nodes) {
        const s = {w:sizesRef.current[n.id]?.w??(n.w||240),h:sizesRef.current[n.id]?.h??n.h??96};
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + s.w);
        maxY = Math.max(maxY, n.y + s.h);
      }
      // Fit is linear in graph size and includes custom node/image dimensions.
      const boxes=new Map(g.nodes.map(n=>[n.id,{x:n.x,y:n.y,w:sizesRef.current[n.id]?.w??(n.w||240),h:sizesRef.current[n.id]?.h??n.h??96}]));
      const detailedFit=Math.min((r.width-96)/Math.max(1,maxX-minX),(r.height-96)/Math.max(1,maxY-minY))>=0.35;
      if(detailedFit&&g.nodes.length*g.edges.length<=200000){
        const routes=routeBoardEdges(boxes,g.edges);
        for(const edge of g.edges){const route=routes.get(edge.id);if(!route)continue;const lines=edgeLabelLines(edge.label??''),width=Math.max(24,...lines.map(s=>Array.from(s).length*12))+16,height=Math.max(24,lines.length*16+12);minX=Math.min(minX,route.mid.x,route.labelPoint.x-width/2);maxX=Math.max(maxX,route.mid.x,route.labelPoint.x+width/2);minY=Math.min(minY,route.mid.y,route.labelPoint.y-height/2);maxY=Math.max(maxY,route.mid.y,route.labelPoint.y+height/2);}
      }

      engine.fit(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        { width: r.width, height: r.height },
      );
    }
    rerender();
    onViewportChange(engine.viewport);
  }, [engine, onViewportChange, rerender]);

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
    if (mutationsBlocked()) return;
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    const h=historyRef.current;if(!canUndo(h))return;
    const nh=histUndo(h);historyRef.current=nh;graphRef.current=nh.present;setHistory(nh);
    onChange(nh.present.nodes,nh.present.edges,engine.viewport);
    setEditingId(null);
    setEditingEdge(null);
  }, [engine, onChange]);

  const doRedo = useCallback(() => {
    if (mutationsBlocked()) return;
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    const h=historyRef.current;if(!canRedo(h))return;
    const nh=histRedo(h);historyRef.current=nh;graphRef.current=nh.present;setHistory(nh);
    onChange(nh.present.nodes,nh.present.edges,engine.viewport);
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
      if (mutationsBlocked()) return;
      if (branchRootRef.current) {
        if (isEditableTarget(e.target) || e.defaultPrevented) return;
        if (e.key === 'Escape' && !document.querySelector('.ctx-menu')) {
          e.preventDefault();
          setBranchFocus(null);
          focusToggle.current?.focus({ preventScroll: true });
        } else if (['delete', 'new-node', 'undo', 'redo'].some(id => hit(id, e))) {
          // WebKit can otherwise interpret Backspace as browser history navigation.
          e.preventDefault();
        }
        return;
      }
      if(edgeRouteCleanup.current){if(e.key==='Escape'){e.preventDefault();edgeRouteCleanup.current();}return;}
      if(arrangeJob.current){if(e.key==='Escape'){e.preventDefault();arrangeJob.current.abort();}return;}
      if(drag.current?.kind==='node'||drag.current?.kind==='resize'){
        if(e.key==='Escape'){e.preventDefault();cancelNodeDrag();}
        if(!isEditableTarget(e.target))return;
      }
      if(e.key==='Escape'&&drag.current?.kind==='connect'){e.preventDefault();connectCleanup.current?.();return;}
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
        if(moveRoot){e.preventDefault();setMoveRoot(null);return;}
        if (fullscreen) return; // App handles leaving fullscreen without closing the panel.
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
    moveRoot,
    setBranchFocus,
    fullscreen,
  ]);

  /* ── 拖拽状态 ── */
  const drag = useRef<
    | null
    | { kind: 'pan'; pointerId: number; startX: number; startY: number; vx: number; vy: number; moved: boolean; allowsNewNode: boolean; nodeId?: string }
    | { kind: 'node'; id: string; pointerId:number;startX:number;startY:number;zoom:number; moved: boolean; baseline: Graph; positions:Map<string,{x:number;y:number}>;group:boolean }
    | { kind: 'resize'; id:string; pointerId:number; startX:number;startY:number;zoom:number;corner:string;box:Box;baseline:Graph;sticker:boolean;image?:PreviewImage;primary:boolean }
    | { kind: 'connect'; fromId: string }
  >(null);
  const blankClicks = useRef<{ x: number; y: number }[]>([]);

  /** 连线拖拽的实时状态（世界坐标）；单独 state 以驱动预览重绘 */
  const connectCleanup=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>connectCleanup.current?.(),[]);
  const [connect, setConnect] = useState<{ fromId: string; to: { x: number; y: number }; hoverId: string | null } | null>(
    null,
  );

  const rect = useCallback(() => wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 }, []);

  const suppressClick = useRef(false);

  /** 取节点世界矩形（用测得尺寸，未测得则兜底） */
  const boxOf = useCallback(
    (n: BoardNode): Box => {
      const s = sizesRef.current[n.id];
      return { x: n.x, y: n.y, w:s?.w??n.w??DEFAULT_NODE_W,h:s?.h??n.h??FALLBACK_NODE_H };
    },
    [],
  );

  /* Keep the wheel listener on the board so WKWebView allows preventDefault. */
  useEffect(() => {
    const canvas = wrapRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.flow-panel, .node-panel, .document-editor-modal, .board-appearance')) return;
      event.preventDefault();
      if (drag.current || branchRootRef.current || !event.deltaY) return;
      const before = engine.viewport;
      const bounds = rect();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? bounds.height : 1;
      engine.zoomByFactor({ x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        Math.exp(-event.deltaY * unit * 0.0015 * appearance.zoomSensitivity));
      const after = engine.viewport;
      if (after.zoom === before.zoom) return;
      blankClicks.current = [];
      scheduleViewportPaint();
      onViewportChange(after);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [appearance.zoomSensitivity, engine, onViewportChange, rect, scheduleViewportPaint]);

  const startPan = useCallback((event: React.PointerEvent, allowsNewNode: boolean, nodeId?: string) => {
    const { x, y } = engine.viewport;
    drag.current = {
      kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      vx: x, vy: y, moved: false, allowsNewNode, nodeId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [engine]);

  /* ── 空白按下：平移 ── */
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (drag.current || arrangeJob.current || mutationsBlocked() || e.target !== e.currentTarget
      || !e.isPrimary || e.button !== 0 || (e.ctrlKey && detectMacOS())) {
      blankClicks.current = [];
      return;
    }
    const allowsNewNode = !(panelId || flowOwnerId || editingId || editingEdge || menu);
    setSelected(null);
    setSelectedEdge(null);
    setPanelId(null);setFlowOwnerId(null);pasteTarget.current=null;pasteFlow.current=null;
    setMoveRoot(null);
    clearTip();
    startPan(e, allowsNewNode);
  };

  /* 阅读时先选中节点才移动，快速移动模式下可直接拖动。 */
  const onNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (drag.current || arrangeJob.current || mutationsBlocked() || !e.isPrimary || e.button !== 0 || (e.ctrlKey && detectMacOS())) return;
    if ((e.target as Element).closest('button, input, textarea, select, a, [contenteditable]')) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('input, textarea, [contenteditable]')) focused.blur();
    e.preventDefault();
    e.stopPropagation();
    suppressClick.current = false;
    if (!quickMove && selectedRef.current !== id) {
      startPan(e, false, id);
      return;
    }
    setSelectedEdge(null);
    const baseline=historyRef.current.present;
    const group=moveRoot===id;
    const ids=group?descendantIds(baseline.nodes,baseline.edges,id):new Set([id]);
    if(group)setMoveIds(ids);
    if(!group)setMoveRoot(null);
    drag.current = {
      kind: 'node',
      id,
      pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,zoom:engine.viewport.zoom,
      moved: false,
      baseline,positions:new Map(baseline.nodes.filter(n=>ids.has(n.id)).map(n=>[n.id,{x:n.x,y:n.y}])),group,
    };
    setDraggingNodes(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [engine, moveRoot, mutationsBlocked, quickMove, startPan]);

  const onResizeStart = useCallback((e: React.PointerEvent, id: string, corner: string, image?: PreviewImage) => {
    if(e.button!==0||mutationsBlocked()||drag.current)return;e.preventDefault();e.stopPropagation();
    const node=graphRef.current.nodes.find(n=>n.id===id);if(!node)return;
    setSelected(id);suppressClick.current=true;
    const sticker = !!e.currentTarget.closest('.node-card')?.classList.contains('is-sticker');
    drag.current={kind:'resize',id,corner,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,zoom:engine.viewport.zoom,box:boxOf(node),baseline:historyRef.current.present,sticker,image,primary:image?.path===contentDocs(node)[0]?.path};
    wrapRef.current?.setPointerCapture(e.pointerId);setDraggingNodes(true);
  }, [boxOf, engine, mutationsBlocked]);
  const previewResize=(d:Extract<NonNullable<typeof drag.current>,{kind:'resize'}>,e:{clientX:number;clientY:number})=>{
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 1) {
      if (historyRef.current.present !== d.baseline) {
        const next = replacePresent(historyRef.current, d.baseline);
        historyRef.current = next; graphRef.current = d.baseline; setHistory(next);
      }
      return;
    }
    let box=(d.sticker?resizedImageBox:resizedBox)(d.box,d.corner,(e.clientX-d.startX)/d.zoom,(e.clientY-d.startY)/d.zoom);
    if(!d.sticker){const min=minimumRef.current[d.id]??{w:120,h:64},w=Math.max(box.w,min.w),h=Math.max(box.h,min.h);box={x:d.corner.includes('w')?d.box.x+d.box.w-w:box.x,y:d.corner.includes('n')?d.box.y+d.box.h-h:box.y,w,h};}
    const original = d.baseline.nodes.find(node => node.id === d.id);
    const image = d.image;
    const current = historyRef.current.present;
    const graph = { ...current, nodes: current.nodes.map(node => {
      if (node.id !== d.id || !original) return node;
      const position = image?.pixels && !d.primary ? { x: box.x, y: box.y } : box;
      if (!image?.pixels) return { ...node, ...position };
      const resized = Math.abs(box.w - d.box.w) > 0.5;
      const originalDisplay = original.docs.find(doc => doc.path === image.path)?.imageDisplay;
      const display = resized ? imageDisplayAt(box.w, image.pixels, true) : originalDisplay;
      const docs = node.docs.map(doc => doc.path === image.path ? { ...doc, imageDisplay: display } : doc);
      return { ...node, ...position, docs };
    }) };
    const next=replacePresent(historyRef.current,graph);historyRef.current=next;graphRef.current=graph;setHistory(next);
  };
  /* ── 锚点按下：开始拉连线 ──
     锚点元素在拖拽中会因 hover 消失而被卸载、指针捕获也会随之失效，
     故不依赖锚点元素/指针捕获，直接挂 window 级监听全程自算，
     并用 graphRef 读取最新节点/连线（规避闭包旧值）。 */
  const onAnchorPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if(drag.current||mutationsBlocked())return;
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
      const hoverId=snapConnection(world,graphRef.current.nodes.filter(node=>mainIdsRef.current.has(node.id)),id,boxOf,engine.viewport.zoom);
      setConnect({ fromId: id, to: world, hoverId });
    };

    const onUp = (ev: PointerEvent) => {
      connectCleanup.current?.();
      if(ev.button!==0)return;
      // 用落点重新命中，避免依赖异步 state
      const r = rect();
      const world = engine.toWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      const target=snapConnection(world,graphRef.current.nodes.filter(node=>mainIdsRef.current.has(node.id)),id,boxOf,engine.viewport.zoom);
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

    const cancel=()=>{window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);drag.current=null;setConnect(null);connectCleanup.current=null;};
    connectCleanup.current=cancel;
    window.addEventListener('pointermove', onMove);window.addEventListener('pointerup', onUp);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
  }, [apply, boxOf, engine, mutationsBlocked, nodes, rect]);

  const previewPan = (d: Extract<NonNullable<typeof drag.current>, { kind: 'pan' }>, e: React.PointerEvent) => {
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    d.moved = true;
    const viewport = engine.viewport;
    if (viewport.x === d.vx + dx && viewport.y === d.vy + dy) return;
    engine.setViewport({ ...viewport, x: d.vx + dx, y: d.vy + dy });
    scheduleViewportPaint();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind === 'connect' || d.pointerId !== e.pointerId) return;
    if (!(e.buttons & 1)) { finishInterruptedDrag(); return; }
    if (d.kind === 'pan') {
      const wasPanning = d.moved;
      previewPan(d, e);
      // A stationary press belongs to the node. Once it becomes a pan, the
      // canvas owns the release, including any click generated from it.
      if (!wasPanning && d.moved && d.nodeId) e.currentTarget.setPointerCapture(e.pointerId);
    } else if (d.kind === 'resize') {previewResize(d,e);
    } else if (d.kind === 'node') {
      previewNodeDrag(d,e);
    }
    // 'connect' 由 onAnchorPointerDown 里的 window 级监听处理，这里不涉及
  };

  const previewNodeDrag=(d:Extract<NonNullable<typeof drag.current>,{kind:'node'}>,e:{clientX:number;clientY:number})=>{
    if(!d.moved&&Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<3)return;
    d.moved=true;
    const next=replacePresent(historyRef.current,{...historyRef.current.present,nodes:translateFromBaseline(historyRef.current.present.nodes,d.positions,(e.clientX-d.startX)/d.zoom,(e.clientY-d.startY)/d.zoom)});
    historyRef.current=next;graphRef.current=next.present;setHistory(next);
  };
  const cancelNodeDrag=useCallback(()=>{
    const d=drag.current;if(d?.kind!=='node'&&d?.kind!=='resize')return;
    drag.current=null;setDraggingNodes(false);setMoveRoot(null);suppressClick.current=true;
    const next=replacePresent(historyRef.current,d.baseline);historyRef.current=next;graphRef.current=d.baseline;setHistory(next);
  }, []);
  const finishInterruptedDrag = useCallback(() => {
    const active = drag.current;
    if (!active || active.kind === 'connect') return;
    if (active.kind === 'pan') {
      drag.current = null;
      blankClicks.current = [];
      if (active.moved) onViewportChange(engine.viewport);
    } else {
      cancelNodeDrag();
    }
    const canvas = wrapRef.current;
    if (canvas?.hasPointerCapture(active.pointerId)) canvas.releasePointerCapture(active.pointerId);
  }, [cancelNodeDrag, engine, onViewportChange]);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) finishInterruptedDrag(); };
    window.addEventListener('blur', finishInterruptedDrag);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('blur', finishInterruptedDrag);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [finishInterruptedDrag]);

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind === 'connect' || d.pointerId !== e.pointerId) return;
    if (e.type === 'pointerup' && e.button !== 0) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.kind === 'pan') {
      if (e.type === 'pointerup') previewPan(d, e);
      if (d.moved) onViewportChange(engine.viewport);
      // Pointer capture can retarget a click to the canvas after the mouse has
      // moved off it. A creation gesture needs two releases over actual blank space.
      if (!d.moved && d.allowsNewNode && e.type === 'pointerup'
        && document.elementFromPoint(e.clientX, e.clientY) === wrapRef.current) {
        blankClicks.current = [...blankClicks.current.slice(-1), { x: e.clientX, y: e.clientY }];
      } else {
        blankClicks.current = [];
      }
    } else if(d.kind==='resize'){
      if(e.type==='pointercancel'){drag.current=d;cancelNodeDrag();return;}
      previewResize(d,e);setDraggingNodes(false);suppressClick.current=true;
      if (historyRef.current.present !== d.baseline) {
        const next=commitFromBaseline(historyRef.current,d.baseline);historyRef.current=next;graphRef.current=next.present;setHistory(next);onChange(next.present.nodes,next.present.edges,engine.viewport);
      }
    } else if (d.kind === 'node') {
      if(e.type==='pointercancel'){drag.current=d;cancelNodeDrag();return;}
      previewNodeDrag(d,e);setDraggingNodes(false);
      suppressClick.current = d.moved || d.group;
      const changed=historyRef.current.present.nodes.some(n=>{const pos=d.positions.get(n.id);return pos&&(n.x!==pos.x||n.y!==pos.y);});
      if (d.moved&&changed) {
        const next = commitFromBaseline(historyRef.current, d.baseline);
        historyRef.current = next;
        setHistory(next);
        onChange(next.present.nodes, next.present.edges, engine.viewport);
      }
      if(d.group&&d.moved)setMoveRoot(null);
    }
    // 'connect' 全程由 onAnchorPointerDown 的 window 监听处理
  };

  const onLostPointerCapture = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind === 'connect' || d.pointerId !== e.pointerId) return;
    // WebKit may deliver the previous release after the next drag has captured the pointer.
    if (e.currentTarget.hasPointerCapture(e.pointerId) || (e.target instanceof Element && e.target.hasPointerCapture(e.pointerId))) return;
    finishInterruptedDrag();
  };

  /* ── 右键：空白 ── */
  const onCanvasContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    const r = rect();
    const world = engine.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { type: 'item', label: '在此新建节点', onClick: () => addNode(world.x, world.y) },
        {type:'item',label:'插入贴图…',onClick:()=>void pickSticker(world)},
        { type: 'separator' },
        { type: 'item', label: '撤销  Ctrl+Z', disabled: !canUndo(history), onClick: doUndo },
        { type: 'item', label: '重做  Ctrl+Shift+Z', disabled: !canRedo(history), onClick: doRedo },
      ],
    });
  };

  const onNodeContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
    setSelected(id);
    setSelectedEdge(null);
    setPanelId(null);setMoveRoot(null);clearTip();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { type: 'item', label: '编辑标签…', onClick: () => {
          const node = graphRef.current.nodes.find(node => node.id === id);
          if (node) onEditTags(node);
        } },
        {type:'item',label:'移动本节点及全部下级',onClick:()=>{setMoveRoot(id);setMoveIds(descendantIds(graphRef.current.nodes,graphRef.current.edges,id));setPanelId(null);setEditingId(null);clearTip();}},
        {type:'separator'},
        { type: 'item', label: '删除节点', danger: true, onClick: () => removeNodeRef.current(id) },
      ],
    });
  }, [clearTip, onEditTags]);

  const onEdgeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if(drag.current?.kind==='node'||drag.current?.kind==='resize')return;
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
  const openPanel = useCallback((id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if(moveRoot===id)return;
    if (moveRoot) setMoveRoot(null);
    const target=graphRef.current.nodes.find(n=>n.id===id);setFlowOwnerId(target?.flow?id:target?.flowOwnerId??null);pasteTarget.current=null;
    setSelected(id);
    setSelectedEdge(null);
    setPanelId(id);
  }, [moveRoot]);

  const exitNodeEdit = useCallback(() => setEditingId(null), []);

  const onNodeHover = useCallback(
    (id: string, hovering: boolean, clientX: number, clientY: number) => {
      setHoverNode((cur) => (hovering ? id : cur === id ? null : cur));
      const node = graphRef.current.nodes.find(n => n.id === id);
      if (!hovering || (node && imageOnly(node))) {
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
  /** 把一组绝对路径的文档复制进白板 docs/ 并挂到节点（去重、逐个导入，返回成功导入数） */
  const importPathsToNode = async (nodeId: string, paths: string[]): Promise<number> => {
    if (paths.length === 0||documentImport.current) return 0;
    const controller=new AbortController();documentImport.current=controller;setDropBusy(true);
    let count=0;
    const failed: string[] = [];
    try {
      for (const p of paths) {
        if (controller.signal.aborted) break;
        try {
          if (IMAGE_FILE.test(p)) {
            setDocumentStatus('正在保存贴图…');
            const policy = await loadWritePolicy();
            const doc = await invoke<DocRef>('document_import', { projectId: board.projectId, boardId: board.id, srcPath: p, expectedScope: policy.scope });
            const pixels = await stickerDimensions(board.projectId, board.id, doc.path);
            if (await mountResource(doc, nodeId, pastePoint(), pixels, null, undefined, controller.signal)) count++;
          } else {
            const next = await attachDocument(board, nodeId, p, text => mounted.current && setDocumentStatus(text), controller.signal);
            if (mounted.current && documentBoard.current === `${board.projectId}/${board.id}`) {
              apply({ nodes: next.nodes, edges: next.edges });
              count++;
            }
          }
        } catch (err) {
          console.error('导入文档失败：', p, err);
          failed.push(`${p.split(/[\\/]/).pop()}：${String(err)}`);
        }
      }
      if (mounted.current) {
        if (failed.length) setDocumentStatus(failed.join('\n'));
        else if (controller.signal.aborted) setDocumentStatus('已停止，已完成的文档保留');
        else if (paths.every(path => IMAGE_FILE.test(path))) setDocumentStatus('已挂载图片', true);
        else setDocumentStatus(`已挂载 ${count} 篇文档`);
      }
      return count;
    } finally {
      documentImport.current = null;
      if (mounted.current) setDropBusy(imageJobs.current > 0);
    }
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
    if(documentImport.current)return;
    const mdPaths = paths.filter((p) => /\.(md|markdown|pdf|zip|png|jpg|jpeg|gif|webp)$/i.test(p));
    if (mdPaths.length === 0) {
      alert('可以拖入 Markdown、PDF 或 Markdown 图片 ZIP。');
      return;
    }
    const n = await importPathsToNode(nodeId, mdPaths);
    if (n > 0 && mounted.current) {
      setSelected(nodeId);
      setFlashId(nodeId);
      window.setTimeout(() => setFlashId(null), 1200);
    }
  };
  importDroppedRef.current = importDroppedToNode;

  const openFlow=(id:string)=>{const g=graphRef.current,node=g.nodes.find(n=>n.id===id);if(!node||node.flowOwnerId)return;if(!node.flow)apply({nodes:g.nodes.map(n=>n.id===id?{...n,flow:{nodeIds:[]}}:n),edges:g.edges});setFlowOwnerId(id);};
  const addFlowStep=(ownerId:string,after?:string)=>{
    const g=graphRef.current,owner=g.nodes.find(n=>n.id===ownerId);if(!owner)return;const now=new Date().toISOString(),node:BoardNode={id:newNodeId(),title:'新步骤',x:0,y:0,w:300,docs:[],flowOwnerId:ownerId,created_at:now,updated_at:now};
    const order=flowNodes(owner,g.nodes).map(n=>n.id),at=after?order.indexOf(after)+1:order.length;order.splice(at,0,node.id);apply(orderFlow([...g.nodes,node],g.edges,ownerId,order,newEdgeId));setPanelId(node.id);setSelected(node.id);pasteTarget.current=node.id;
  };
  const promoteDoc=(id:string,path:string)=>{const g=graphRef.current;apply({nodes:g.nodes.map(n=>n.id===id?{...n,docs:[...n.docs.filter(d=>d.path===path),...n.docs.filter(d=>d.path!==path)]}:n),edges:g.edges});};
  const newDocument=async(nodeId:string)=>{
    try{const doc=await api.docWrite(board.projectId,board.id,'新建Markdown','');if(!mounted.current)return;
      const g=graphRef.current;apply({nodes:g.nodes.map(n=>n.id===nodeId?{...n,docs:[...n.docs,doc]}:n),edges:g.edges});setDocumentEditor({nodeId,path:doc.path,title:doc.title});
    }catch(e){setDocumentStatus(String(e));throw e;}
  };
  const stickerImport=useRef<(path?:string,file?:File,point?:{x:number;y:number},target?:string|null,flow?:string|null)=>Promise<void>>(async()=>{});
  const importBlank=useRef<(paths:string[],point:{x:number;y:number},flow?:string|null)=>Promise<void>>(async()=>{});
  const textPaste=useRef<(text:string,target:string|null,flow:string|null)=>Promise<void>>(async()=>{});
  const mountResource = async (doc: DocRef, target: string | null, point: { x: number; y: number }, pixels?: ImagePixels, flowId?: string | null, title?: string, signal?: AbortSignal) => {
    if (!mounted.current || signal?.aborted) return false;
    const display = pixels ? await imageSizing.suggest(graphRef.current.nodes, pixels, !!target) : undefined;
    if (!mounted.current || signal?.aborted) return false;
    if (syncMutationLock.current) throw Error('白板正在同步，请稍后再试');
    if (drag.current?.kind === 'resize') cancelNodeDrag();
    const g = graphRef.current;
    const reference = display ? { ...doc, imageDisplay: display } : doc;
    if (target) {
      const existing = g.nodes.find(node => node.id === target);
      if (!existing) throw Error('目标节点已不存在');
      if (existing.docs.some(attached => attached.path === doc.path)) return false;
      const docs = [...existing.docs, reference];
      const size = display && !contentDocs(existing).length ? { w: display.width } : {};
      apply({ nodes: g.nodes.map(node => node.id === target ? { ...node, ...size, docs } : node), edges: g.edges });
      return true;
    }
    const now = new Date().toISOString(), isImage = !!display;
    const size = display ? { w: display.width, h: display.width * display.pixelHeight / display.pixelWidth } : { w: 420, h: undefined };
    const n:BoardNode={id:newNodeId(),title:isImage?'':title??doc.title,x:point.x-size.w/2,y:point.y-(size.h??80)/2,...size,sticker:isImage,imageAspect:pixels?pixels.width/pixels.height:undefined,docs:[reference],flowOwnerId:flowId??undefined,created_at:now,updated_at:now};
    if(flowId){const owner=g.nodes.find(n=>n.id===flowId);apply(orderFlow([...g.nodes,n],g.edges,flowId,[...(owner?.flow?.nodeIds??[]),n.id],newEdgeId));setPanelId(n.id);setFlowOwnerId(flowId);}else apply({nodes:[...g.nodes,n],edges:g.edges});setSelected(n.id);
    return true;
  };
  const pastePoint=()=>{const r=rect();return engine.toWorld({x:r.width/2,y:r.height/2});};
  stickerImport.current=async(path,file,point,target=null,flow=null)=>{
    if(mutationsBlocked())return;
    imageJobs.current++;setDropBusy(true);setDocumentStatus('正在保存贴图…');
    try{let base64Data:string|undefined;
      if(file){if(file.size>16*1024*1024)throw Error('贴图最多16MiB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));base64Data=btoa(binary);}
      const permission=await loadWritePolicy();const doc=await invoke<DocRef>('image_document',{projectId:board.projectId,boardId:board.id,srcPath:path??null,base64Data:base64Data??null,expectedScope:permission.scope});
      const dimensions=await stickerDimensions(board.projectId,board.id,doc.path);
      const added = await mountResource(doc, target, point ?? pastePoint(), dimensions, flow);
      if (mounted.current) setDocumentStatus(!added ? '此图片已挂载' : target ? '已挂载图片' : '已插入贴图', true);
    }catch(e){if(mounted.current)setDocumentStatus(`插入贴图失败：${String(e)}`);}
    finally{imageJobs.current--;if(mounted.current)setDropBusy(imageJobs.current>0||!!documentImport.current);}
  };
  importBlank.current=async(paths,point,flow=null)=>{
    if(mutationsBlocked())return;
    for(const path of paths.filter(p=>/\.(md|markdown|pdf|zip|png|jpg|jpeg|gif|webp)$/i.test(p))){
      imageJobs.current++;setDropBusy(true);setDocumentStatus('正在导入资源…');
      try{const policy=await loadWritePolicy(),doc=await invoke<DocRef>('document_import',{projectId:board.projectId,boardId:board.id,srcPath:path,expectedScope:policy.scope});
        const dimensions=imageDoc(doc)?await stickerDimensions(board.projectId,board.id,doc.path):undefined;
        if (await mountResource(doc, null, point, dimensions, flow)) setDocumentStatus(dimensions ? '已插入贴图' : '已导入文档与原件', !!dimensions);
      }catch(error){if(mounted.current)setDocumentStatus(String(error));}
      finally{imageJobs.current--;if(mounted.current)setDropBusy(imageJobs.current>0||!!documentImport.current);}
    }
  };
  textPaste.current=async(text,target,flow)=>{
    if(!text.trim()||mutationsBlocked())return;
    const plan=clipboardText(text);imageJobs.current++;setDropBusy(true);
    try{if(target||plan.document){const doc=await api.docWrite(board.projectId,board.id,plan.title||'粘贴的内容',text);await mountResource(doc,target,pastePoint(),undefined,flow,plan.title);}
      else{const now=new Date().toISOString(),at=pastePoint(),node:BoardNode={id:newNodeId(),title:plan.title,x:at.x-130,y:at.y-30,w:260,docs:[],flowOwnerId:flow??undefined,created_at:now,updated_at:now},g=graphRef.current;if(flow){const owner=g.nodes.find(n=>n.id===flow);apply(orderFlow([...g.nodes,node],g.edges,flow,[...(owner?.flow?.nodeIds??[]),node.id],newEdgeId));setPanelId(node.id);}else apply({nodes:[...g.nodes,node],edges:g.edges});setSelected(node.id);}
      setDocumentStatus(target?'已挂载文字文档':'已从剪贴板创建节点');
    }catch(error){if(mounted.current)setDocumentStatus(String(error));}
    finally{imageJobs.current--;if(mounted.current)setDropBusy(imageJobs.current>0||!!documentImport.current);}
  };
  useEffect(()=>{const beforeClose=(e:Event)=>{arrangeJob.current?.abort();if(imageJobs.current){e.preventDefault();setDocumentStatus('资源正在保存，请完成后再关闭。');}};window.addEventListener('lumen:before-window-close',beforeClose);return()=>{arrangeJob.current?.abort();window.removeEventListener('lumen:before-window-close',beforeClose);};},[]);
  useEffect(()=>{
    const region=(e:PointerEvent)=>{if(branchRootRef.current)return;const el=e.target as HTMLElement;if(el.closest('.node-panel')){pasteTarget.current=panelIdRef.current;pasteFlow.current=null;}else if(el.closest('.flow-panel')){pasteTarget.current=el.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId??null;pasteFlow.current=el.closest<HTMLElement>('[data-flow-owner]')?.dataset.flowOwner??null;}else if(el.closest('.board-canvas-live')){pasteTarget.current=null;pasteFlow.current=null;}};
    const paste=(e:ClipboardEvent)=>{
      if(branchRootRef.current||document.querySelector('[aria-modal="true"]'))return;
      const target=(e.target as HTMLElement)?.closest?.('.node-panel')?panelIdRef.current:pasteTarget.current,flow=target?null:pasteFlow.current;
      const files=[...(e.clipboardData?.files??[])].filter(f=>/^image\/(png|jpeg|gif|webp)$/.test(f.type));
      if(files.length){
        e.preventDefault();
        void (async () => {
          for (const file of files) {
            if (!mounted.current) break;
            await stickerImport.current(undefined, file, undefined, target, flow);
          }
        })();
        return;
      }
      if(isEditableTarget(e.target))return;const text=e.clipboardData?.getData('text/plain');if(text?.trim()){e.preventDefault();void textPaste.current(text,target,flow);}
    };
    window.addEventListener('pointerdown',region,true);window.addEventListener('paste',paste);return()=>{window.removeEventListener('pointerdown',region,true);window.removeEventListener('paste',paste);};
  },[]);
  const pickSticker=async(point?:{x:number;y:number})=>{const path=await open({title:'插入白板贴图',multiple:false,filters:[{name:'图片',extensions:['png','jpg','jpeg','gif','webp']}]});if(typeof path==='string')await stickerImport.current(path,undefined,point);};
  const openDoc = (_nodeId: string, path: string, title: string) => {
    void openReaderWindow({ projectId: board.projectId, boardId: board.id, path, title });
  };

  const removeDoc = async (nodeId: string, path: string) => {
    // Unmount only: shared documents and undo/history retain their original bytes.
    const g = graphRef.current;
    apply({
      nodes: g.nodes.map((n) =>
        n.id === nodeId
          ? nonemptyNode({ ...n, docs: n.docs.filter((d) => d.path !== path), updated_at: new Date().toISOString() })
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
    const g=graphRef.current,target=g.nodes.find(n=>n.id===id);if(!target)return;
    const children=flowNodes(target,g.nodes),promoted=new Map(children.map((n,i)=>[n.id,{...n,flowOwnerId:undefined,x:target.x+35,y:target.y+i*180}]));
    let next={nodes:g.nodes.filter(n=>n.id!==id).map(n=>promoted.get(n.id)??n),edges:g.edges.filter(e=>e.from!==id&&e.to!==id)};
    if(target.flowOwnerId){const owner=next.nodes.find(n=>n.id===target.flowOwnerId);if(owner)next=orderFlow(next.nodes,next.edges,owner.id,owner.flow?.nodeIds.filter(n=>n!==id)??[],newEdgeId);}
    apply(next);if(flowOwnerId===id)setFlowOwnerId(null);if(selected===id)setSelected(null);if(editingId===id)setEditingId(null);if(panelId===id)setPanelId(null);clearTip();
  };
  removeNodeRef.current = removeNode;

  const commitNode = useCallback((id: string, patch: { title?: string; summary?: string }) => {
    const g=graphRef.current,target=g.nodes.find(n=>n.id===id);if(!target)return;
    const title=patch.title??target.title,summary=patch.summary!==undefined?patch.summary:target.summary;
    if(title===target.title&&summary===target.summary)return;
    const docs=patch.summary!==undefined&&!target.docs.some(d=>d.path===questionPath(id))?[...target.docs,{path:questionPath(id),title:'完整问题',bytes:new TextEncoder().encode(summary??'').length}]:target.docs;
    apply({nodes:g.nodes.map(n=>n.id===id?nonemptyNode({...n,title,summary,docs,sticker:patch.title!==undefined?false:n.sticker,updated_at:new Date().toISOString()}):n),edges:g.edges});
  }, [apply]);

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const [first, second] = blankClicks.current;
    blankClicks.current = [];
    if (!first || !second || e.target !== e.currentTarget || mutationsBlocked()) return;
    if (Math.hypot(first.x - second.x, first.y - second.y) <= 6) addNodeAtScreen(second.x, second.y);
  };

  /* ── 缩放越小、节点热力光越明显 ── */
  const zoom = engine.viewport.zoom;
  const intensity = Math.max(0, Math.min(1, (0.85 - zoom) / 0.6));
  const glowVars = {
    ['--image-pager-scale' as string]: 1 / Math.min(zoom, 1),
    ['--glow-blur' as string]: `${(20 * intensity) / zoom}px`,
    ['--glow-spread' as string]: `${(3.5 * intensity) / zoom}px`,
    ['--glow-alpha' as string]: `${0.12 + 0.6 * intensity}`,
    ['--flow-border-width' as string]: `${2 / zoom}px`,
    ['--flow-glow-blur' as string]: `${14 / zoom}px`,
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
      const w = s?.w??n.w??DEFAULT_NODE_W;
      const h = s?.h??n.h??FALLBACK_NODE_H;
      const tl = engine.toScreen({ x: n.x, y: n.y });
      const z = engine.viewport.zoom;
      return { x: tl.x, y: tl.y, w: w * z, h: h * z };
    },
    [engine],
  );

  const vp = engine.viewport;
  const vpSig = `${vp.x},${vp.y},${vp.zoom}`;

  const level=heatLevel(zoom),heatMode=level>0;
  const heatCells=useMemo(()=>level?aggregateHeat(mainNodes,level,sizesRef.current):[],[mainNodes,level,sizesVer]);
  const visibleWorld=engine.visibleWorldRect(canvasSize);
  const visibleBox={x:visibleWorld.x,y:visibleWorld.y,w:visibleWorld.width,h:visibleWorld.height};
  const gesture = drag.current;
  const pressedNode = gesture?.kind === 'pan' ? gesture.nodeId : gesture?.kind === 'node' ? gesture.id : undefined;
  const visibleNodes=heatMode?[]:mainNodes.filter(n=>n.id===editingId||n.id===selected||n.id===pressedNode||intersects(boxOf(n),visibleBox,100/zoom));
  const renderedHeat=heatMode?heatCells.filter(c=>intersects(c,visibleBox,80/zoom)):[];

  const laidEdges = useMemo(() => {
    void sizesVer;
    void vpSig;
    if(heatMode)return [];
    const candidates=mainEdges.filter(e=>{const a=nodeById[e.from],b=nodeById[e.to];if(!a||!b)return false;const ab=boxOf(a),bb=boxOf(b),c=e.route?.control;const x=Math.min(ab.x,bb.x,c?.x??Infinity),y=Math.min(ab.y,bb.y,c?.y??Infinity),right=Math.max(ab.x+ab.w,bb.x+bb.w,c?.x??-Infinity),bottom=Math.max(ab.y+ab.h,bb.y+bb.h,c?.y??-Infinity);return intersects({x,y,w:right-x,h:bottom-y},visibleBox,100/zoom);});
    const ids=new Set(candidates.flatMap(e=>[e.from,e.to]));
    const boxes=new Map(mainNodes.filter(n=>ids.has(n.id)).map(n=>[n.id,screenBoxOf(n)]));
    const screenEdges=candidates.map(e=>e.route?.control?{...e,route:{...e.route,control:engine.toScreen(e.route.control)}}:e);
    const routed=routeBoardEdges(boxes,screenEdges,engine.viewport.zoom);
    return candidates.flatMap(edge => {
      const geo = routed.get(edge.id);
      return geo ? [{ edge, geo }] : [];
    });
  }, [mainEdges, nodeById, screenBoxOf, sizesVer, vpSig, heatMode, canvasSize]);

  // Opening a flow brings its owner into view. Resizing the window keeps the current camera.
  useEffect(() => {
    if (!flowOwnerId || branchRootRef.current) return;
    const owner = graphRef.current.nodes.find(n => n.id === flowOwnerId);
    if (!owner) return;
    const { width, height } = rect();
    const left = Math.min(520, Math.max(310, width * 0.43)) + 16;
    const right = width - 332;
    const size = sizesRef.current[owner.id];
    const at = engine.toScreen({ x: owner.x + (size?.w ?? owner.w) / 2, y: owner.y + (size?.h ?? owner.h ?? 96) / 2 });
    engine.setViewport({
      ...engine.viewport,
      x: engine.viewport.x + (left + right) / 2 - at.x,
      y: engine.viewport.y + Math.max(120, Math.min(height - 120, at.y)) - at.y,
    });
    rerender();
    onViewportChange(engine.viewport);
  }, [engine, flowOwnerId, onViewportChange, rect, rerender]);

  // At overview scale, nearby relationship captions merge into bounded luminous hints.
  const overviewLabels=useMemo(()=>{
    if(!heatMode)return [];
    const bins=new Map<string,{id:string;label:string;x:number;y:number;count:number}>();
    for(const e of mainEdges){if(!e.label)continue;const a=nodeById[e.from],b=nodeById[e.to];if(!a||!b)continue;
      const p=engine.toScreen(e.route?.control??{x:(a.x+a.w/2+b.x+b.w/2)/2,y:(a.y+(a.h??96)/2+b.y+(b.h??96)/2)/2});
      if(p.x<0||p.y<0||p.x>canvasSize.width||p.y>canvasSize.height)continue;
      const key=`${Math.floor(p.x/48)}:${Math.floor(p.y/48)}`,old=bins.get(key);
      if(old)old.count++;else bins.set(key,{id:e.id,label:e.label,x:p.x,y:p.y,count:1});
    }
    return [...bins.values()];
  },[mainEdges,nodeById,heatMode,vpSig,canvasSize]);

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
  const beginEdgeRoute=(event:React.PointerEvent<SVGCircleElement>,id:string)=>{
    if(event.button!==0||mutationsBlocked()||imageJobs.current||documentImport.current||arrangeJob.current)return;
    event.preventDefault();event.stopPropagation();const baseline=historyRef.current.present,edge=baseline.edges.find(e=>e.id===id);if(!edge)return;
    const start={x:event.clientX,y:event.clientY},pointer=event.pointerId;let moved=false;
    const preview=(e:PointerEvent)=>{if(e.pointerId!==pointer)return;if(!moved&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<3)return;moved=true;
      const r=rect(),point=engine.toWorld({x:e.clientX-r.left,y:e.clientY-r.top}),from=graphRef.current.nodes.find(n=>n.id===edge.from),to=graphRef.current.nodes.find(n=>n.id===edge.to);if(!from||!to)return;
      const route: NonNullable<BoardEdge['route']> = nearStraightLine(boxOf(from), boxOf(to), point, engine.viewport.zoom)
        ? { kind: 'straight' } : { kind: 'bent', control: point };
      const next=replacePresent(historyRef.current,{...historyRef.current.present,edges:historyRef.current.present.edges.map(e=>e.id===id?{...e,route}:e)});historyRef.current=next;graphRef.current=next.present;setHistory(next);
    };
    const clean=()=>{window.removeEventListener('pointermove',preview);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('lumen:sync-edit-lock',cancel);edgeRouteCleanup.current=null;setDraggingNodes(false);if(wrapRef.current?.hasPointerCapture(pointer))wrapRef.current.releasePointerCapture(pointer);};
    const cancel=()=>{clean();const state=replacePresent(historyRef.current,baseline);historyRef.current=state;graphRef.current=state.present;setHistory(state);};
    const up=(e:PointerEvent)=>{if(e.pointerId!==pointer)return;preview(e);clean();if(moved){const next=commitFromBaseline(historyRef.current,baseline);historyRef.current=next;graphRef.current=next.present;setHistory(next);onChange(next.present.nodes,next.present.edges,engine.viewport);}};
    edgeRouteCleanup.current=cancel;setDraggingNodes(true);wrapRef.current?.setPointerCapture(pointer);window.addEventListener('pointermove',preview);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('lumen:sync-edit-lock',cancel);
  };
  useEffect(()=>()=>edgeRouteCleanup.current?.(),[]);
  const onDocumentSaved=useCallback((bytes:number)=>{
    if(!documentEditor)return;
    const g=graphRef.current,next={...g,nodes:g.nodes.map(n=>n.id===documentEditor.nodeId?{...n,docs:n.docs.map(d=>d.path===documentEditor.path?{...d,bytes}:d)}:n)};
    const state=replacePresent(historyRef.current,next);historyRef.current=state;graphRef.current=next;setHistory(state);
    setDocVersions(v=>({...v,[documentEditor.path]:(v[documentEditor.path]??0)+1}));onChange(next.nodes,next.edges,engine.viewport);
  },[documentEditor?.nodeId,documentEditor?.path,onChange,engine]);


  const fontStyle = {
    ['--board-font-family' as string]: FONT_FAMILIES[appearance.fontFamily],
    ['--board-font-size' as string]: `${appearance.fontSize}px`,
    ['--board-preview-font-family' as string]: FONT_FAMILIES[appearance.previewFontFamily ?? appearance.fontFamily],
    ['--board-preview-font-size' as string]: `${appearance.previewFontSize ?? appearance.fontSize}px`,
  };
  const focusBusy = draggingNodes || arrangeBusy || dropBusy || !!editingId || !!editingEdge || !!documentEditor || !!connect;
  return <div className="board-view-stack">
    <div
      ref={wrapRef}
      className={`board-canvas board-canvas-live${connect ? ' is-connecting' : ''}${branchRoot ? ' is-behind-focus' : ''}${quickMove ? ' is-quick-move' : ''}`}
      aria-hidden={branchRoot ? true : undefined}
      onScroll={e=>{if(e.target===e.currentTarget){e.currentTarget.scrollLeft=0;e.currentTarget.scrollTop=0;}}}
      onPointerDownCapture={e => {
        if (e.target !== e.currentTarget) blankClicks.current = [];
        const active = drag.current;
        if (e.isPrimary && e.button === 0 && active?.kind === 'pan' && active.pointerId === e.pointerId) finishInterruptedDrag();
      }}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      style={fontStyle}
      aria-busy={draggingNodes||dropBusy||arrangeBusy}
      onContextMenu={onCanvasContextMenu}
      onDoubleClick={onCanvasDoubleClick}
    >
      {arrangeBusy&&<div className="arrange-progress" role="status"><span>{documentStatus||'正在适配节点内容…'}</span><button className="btn" onClick={()=>arrangeJob.current?.abort()}>停止整理</button></div>}
      {/* 悬浮工具栏：撤销 / 重做 / 整理 / 缩放 / 适配 */}
      {notice&&<div className={`document-import-status${notice.fading ? ' is-fading' : ''}`} role="status" onPointerDown={e=>e.stopPropagation()}><span>{notice.text}</span>{dropBusy&&<button type="button" className="btn" disabled={!documentImport.current||notice.text==='正在保存文档与原件'} onClick={()=>documentImport.current?.abort()}>停止</button>}<button type="button" className="btn" onClick={()=>setDocumentStatus('')} disabled={dropBusy}>关闭</button></div>}
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
        <button type="button" className="tb-btn" title="适配全部内容 (Shift+1)" aria-label="适配全部内容到屏幕" onClick={fitAll}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 连线层：覆盖整块画布的全尺寸 SVG，用屏幕坐标绘制（避免 0×0 世界层不渲染）。
          置于节点层之下（DOM 顺序在前 + CSS 定位），指针默认穿透、仅命中区可点。 */}
      <button className="canvas-zoom-label" title="点击恢复100% · 滚轮或快捷键缩放" aria-label={`当前缩放 ${zoom<0.01?(zoom*100).toFixed(1):Math.round(zoom*100)}%，点击重置为100%`} onPointerDown={e=>e.stopPropagation()} onClick={zoomReset}>{zoom<0.01?(zoom*100).toFixed(1):Math.round(zoom*100)}%</button>
      {heatMode&&<div className="heat-layer" aria-label={`热力概览，共${mainNodes.length}个节点`} data-level={level}>{renderedHeat.map(c=>{
        const at=engine.toScreen(c);return <button type="button" key={c.id} className={`heat-cell${c.flowCount?' has-flow':''}`} data-count={c.count} data-flow-count={c.flowCount} title={`${c.count}个节点${c.flowCount?` · ${c.flowCount}个含子流程`:''} · 点击逐级展开`} aria-label={`展开${c.count}个节点的热力区域${c.flowCount?'，包含子流程':''}`} style={{left:at.x,top:at.y,width:Math.max(8,c.w*zoom),height:Math.max(8,c.h*zoom),opacity:c.flowCount?1:Math.min(.95,.45+Math.log2(c.count+1)*.08),['--heat-color' as string]:c.color||'var(--accent)',['--flow-glow' as string]:flowHighlight(c.flowColor)}} onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();const r=rect();engine.zoomAtPoint({x:r.width/2,y:r.height/2},Math.min(1,zoom*2));const z=engine.viewport.zoom;engine.setViewport({zoom:z,x:r.width/2-(c.x+c.w/2)*z,y:r.height/2-(c.y+c.h/2)*z});rerender();onViewportChange(engine.viewport);}}>{c.count>1?c.count:''}</button>;
      })}</div>}
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
              {/* 可见连线 */}
              <path
                className="edge-line"
                d={geo.d}
                fill="none"
                pathLength={1}
                markerEnd={edge.directed ? (isSel ? 'url(#lm-arrow-sel)' : 'url(#lm-arrow)') : undefined}
              />
              {isSel&&<circle className="edge-route-handle" cx={geo.mid.x} cy={geo.mid.y} r={8} role="button" aria-label="拖动调整连线弯折" onPointerDown={e=>beginEdgeRoute(e,edge.id)}/>}

            </g>
          );
        })}

        {/* 拖拽预览 */}
        {connectPreview && (
          <path className="edge-preview" d={connectPreview} fill="none" />
        )}
      </svg>

      <div className="edge-label-layer">{overviewLabels.map(h=><EdgeLabel key={h.id} label={h.count>1?`${h.count}条连线含说明；${h.label}`:h.label} x={h.x} y={h.y} zoom={zoom} onSelect={()=>{setSelectedEdge(h.id);zoomCenter(2);}} onEdit={()=>zoomCenter(2)}/>)}{laidEdges.map(({edge,geo})=>edge.label&&editingEdge!==edge.id?<EdgeLabel key={edge.id} label={edge.label} x={geo.labelPoint.x} y={geo.labelPoint.y-(selectedEdge===edge.id&&geo.labelPoint===geo.mid?24:0)} zoom={zoom} onSelect={()=>{setSelectedEdge(edge.id);setSelected(null);}} onEdit={()=>startEdgeLabel(edge.id)}/>:null)}</div>
      {/* 世界层：只改 transform（DESIGN §5.4） */}
      <div className={`canvas-world${arranging ? ' is-arranging' : ''}`} style={{ transform: engine.transform, transformOrigin: '0 0', ...glowVars }}>
        {visibleNodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n} projectId={board.projectId} boardId={board.id} onResizeStart={onResizeStart} onImageSize={imageSizing.observe} docVersions={docVersions}
            previewCollapsed={Boolean(matches && !matches.matched.has(n.id))}
            selected={selected === n.id||!!moveRoot&&moveIds.has(n.id)}
            flash={flashId === n.id}
            editing={editingId === n.id}
            showAnchors={(selected === n.id || hoverNode === n.id) && editingId !== n.id}
            connectTarget={connect?.hoverId === n.id}
            dropTarget={dropTargetId === n.id}
            onPointerDown={onNodePointerDown}
            onAnchorPointerDown={onAnchorPointerDown}
            onOpen={openPanel}
            onStartEdit={setEditingId}
            onContextMenu={onNodeContextMenu}
            onCommit={commitNode}
            onEditCancel={exitNodeEdit}
            onExitEdit={exitNodeEdit}
            onMeasure={onMeasure}
            onHoverChange={onNodeHover}
          />
        ))}
      </div>

      {matches && !mainNodes.length && <p className="board-filter-empty" role="status">当前没有匹配标签的节点</p>}

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

      {mainNodes.length === 0 && (
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
      {moveRoot&&<div className="drop-hint tree-move-hint" role="status">拖动此节点，移动全部 {moveIds.size} 个节点<button className="btn" onClick={()=>{cancelNodeDrag();setMoveRoot(null);}}>取消</button></div>}

      {/* 悬停简介 tooltip（不拦截指针） */}
      {tip && !panelId && (() => {
        const tn = nodes.find((n) => n.id === tip.id);
        return tn ? <NodeTooltip node={tn} x={tip.x} y={tip.y} /> : null;
      })()}

      {/* 节点内容面板（选中节点后停靠右侧） */}
      {panelId && (() => {
        const pn = nodes.find((n) => n.id === panelId);
        if (!pn || (matches && !matches.matched.has(pn.id) && !matches.entrances.has(pn.id))) return null;
        const labels = assignedTags(tagStore, { kind: 'node', projectId: board.projectId, boardId: board.id, id: pn.id });
        const legacy = colorTag(pn.color);
        return (
          <NodePanel
            node={pn} docVersions={docVersions}
            onCommit={commitNode}
            onColor={setNodeColor}
            tags={tags.filter(tag => tag.id === legacy || labels.includes(tag.id))}
            onEditTags={() => onEditTags(pn)}
            onDelete={removeNode}
            onClose={() => setPanelId(null)}
            onOpenDoc={openDoc}
            onImportDocs={importDocs}
            onRemoveDoc={removeDoc}
            onEditMarkdown={()=>setDocumentEditor({nodeId:pn.id,path:questionPath(pn.id),title:'完整问题',kind:'question'})} onOpenFlow={()=>openFlow(pn.id)} onPromoteDoc={promoteDoc}
            projectId={board.projectId}
            boardId={board.id}
            guessMath={guessMath}
          />
        );
      })()}

      {flowOwnerId && nodeById[flowOwnerId]?.flow && mainIds.has(flowOwnerId) && (() => {
        const owner = nodeById[flowOwnerId];
        const steps = flowNodes(owner, nodes);
        return <FlowPanel key={flowOwnerId} owner={owner} nodes={matches ? steps.filter(node => matches.matched.has(node.id)) : steps}
          filtering={!!matches} projectId={board.projectId} boardId={board.id} selected={selected} panelId={panelId}
          ownerBox={screenBoxOf(owner)} zoomSensitivity={appearance.zoomSensitivity} quickMove={quickMove}
          docVersions={docVersions} onClose={() => setFlowOwnerId(null)}
          onSelect={id => { setPanelId(id); setSelected(id); pasteTarget.current = id; }}
          onAdd={after => addFlowStep(flowOwnerId, after)} onEditTags={onEditTags}
          onReorder={order => {
            const g = graphRef.current;
            const currentOwner = g.nodes.find(node => node.id === flowOwnerId);
            if (!currentOwner) return;
            const changed = new Set(order);
            let next = 0;
            // Reorder visible steps in their original slots, keeping filtered steps in the flow.
            const all = flowNodes(currentOwner, g.nodes)
              .map(node => changed.has(node.id) ? order[next++] : node.id);
            apply(orderFlow(g.nodes, g.edges, flowOwnerId, all, newEdgeId));
          }} onRemove={removeNode} />;
      })()}
      {appearanceOpen&&<BoardAppearancePanel name={board.name} value={board.appearance} onClose={()=>setAppearanceOpen(false)} onChange={v=>onChange(graphRef.current.nodes,graphRef.current.edges,engine.viewport,v)}/>}
      {documentEditor&&(()=>{
        const node=nodes.find(n=>n.id===documentEditor.nodeId);if(!node)return null;
        const docs=node.docs.filter(d=>d.path!==questionPath(node.id)),counts=new Map<string,number>();for(const d of docs)counts.set(d.title,(counts.get(d.title)??0)+1);
        const choices=[{path:questionPath(node.id),title:'完整问题'},...docs.map(d=>({path:d.path,title:(counts.get(d.title)??0)>1?`${d.title} · ${d.path.replace(/^docs\//,'')}`:d.title||d.path}))];
        const choose=(path:string)=>{const doc=choices.find(d=>d.path===path);if(doc)setDocumentEditor({nodeId:node.id,path,title:doc.title,kind:path===questionPath(node.id)?'question':undefined});};
        return documentEditor.kind==='question'?<QuestionEditor key={documentEditor.path} value={node.summary??''} onChange={v=>commitNode(node.id,{summary:v})} onFlush={onFlush} saveState={saveState} onClose={()=>setDocumentEditor(undefined)} path={documentEditor.path} choices={choices} onChoose={choose} onNew={()=>newDocument(node.id)}/>:<DocumentEditor key={documentEditor.path} {...documentEditor} projectId={board.projectId} boardId={board.id} onClose={()=>setDocumentEditor(undefined)} onSaved={onDocumentSaved} choices={choices} onChoose={choose} onNew={()=>newDocument(node.id)}/>;
      })()}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
    {branchRoot && <BranchFocusView key={branchRoot} rootId={branchRoot} nodes={nodes} edges={edges} size={canvasSize}
      projectId={board.projectId} boardId={board.id} docVersions={docVersions} fontStyle={fontStyle} zoomSensitivity={appearance.zoomSensitivity} quickMove={quickMove}/>}
    {actionSlot && createPortal(<>
      <TitleBarButton className="titlebar-btn titlebar-menu quick-move-toggle" aria-label="快速移动" aria-pressed={quickMove}
        hint={quickMove ? '关闭快速移动，恢复先选中再拖动' : '光标放在节点上，三指拖动即可移动'}
        onClick={() => { if (!drag.current && !mutationsBlocked()) setQuickMove(active => !active); }}>
        <Move size={17} aria-hidden="true" />
      </TitleBarButton>
      {(branchRoot || (selected && nodeById[selected])) &&
        <TitleBarButton buttonRef={focusToggle} className="titlebar-btn branch-focus-toggle" aria-pressed={!!branchRoot}
          aria-label={branchRoot ? '退出专注视图' : '开启专注视图'} hint={branchRoot ? '退出专注视图 · Esc' : '专注于选中节点的分支'}
          disabled={!branchRoot && focusBusy} onClick={() => {
            if (branchRoot) { setBranchFocus(null); return; }
            if (focusBusy || drag.current || edgeRouteCleanup.current || mutationsBlocked()) return;
            blankClicks.current = [];
            setBranchFocus(selected);
          }}>
          {branchRoot ? <X size={16} aria-hidden="true"/> : <Focus size={17} aria-hidden="true"/>}
          <span>{branchRoot ? '退出专注' : '专注视图'}</span>
        </TitleBarButton>}
    </>, actionSlot)}
    </div>;
}
