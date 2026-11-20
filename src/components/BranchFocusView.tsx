import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { GitFork, LocateFixed, Maximize } from 'lucide-react';
import type { BoardEdge, BoardNode } from '../api';
import { fitToBounds, viewportToTransform, visibleWorldRect, worldToScreen, zoomByFactor, type Size, type Viewport } from '../canvas/CanvasEngine';
import { focusBranch, layoutFocusBranch } from '../canvas/branchFocus';
import { routeBoardEdges } from '../canvas/edgeRouting';
import type { Box } from '../canvas/geometry';
import { aggregateHeat, heatLevel, intersects, MIN_BOARD_ZOOM } from '../canvas/presentation';
import { matchShortcut, shortcut } from '../canvas/shortcuts';
import { EdgeLabel } from './EdgeLabel';
import { NodeCard } from './NodeCard';
import { copyPreviewMemory } from './NodePreview';

const FIT = { minZoom: MIN_BOARD_ZOOM, maxZoom: 1.12, fitPadding: 52 };
const noop = () => {};

function startViewport(scene: ReturnType<typeof layoutFocusBranch>, size: Size): Viewport {
  const overview = fitToBounds(scene.bounds, size, FIT);
  if (overview.zoom >= 0.82) return overview;
  const root = scene.cards[0].box;
  // For a long branch, start with a readable root and the beginning of the workflow.
  const step = scene.cards.find(card => card.step)?.box;
  const zoom = Math.max(MIN_BOARD_ZOOM, Math.min(1, (size.width - 104) / root.w));
  const aim = step && step.x > 0 ? (step.x + Math.min(440, step.w) / 2) / 2 : 0;
  const x = Math.max(52 - root.x * zoom, size.width / 2 - aim * zoom);
  return { x, y: 78 - root.y * zoom, zoom };
}

function recenter(box: Box, size: Size, zoom: number): Viewport {
  return { x: size.width / 2 - (box.x + box.w / 2) * zoom, y: size.height / 2 - (box.y + box.h / 2) * zoom, zoom };
}

export function BranchFocusView({ rootId, nodes, edges, projectId, boardId, docVersions, size, fontStyle, zoomSensitivity }: {
  rootId: string; nodes: BoardNode[]; edges: BoardEdge[]; projectId: string; boardId: string;
  docVersions: Record<string, number>; size: Size; fontStyle: CSSProperties; zoomSensitivity: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, '');
  useLayoutEffect(() => { host.current?.focus({ preventScroll: true }); }, []);
  const [memory] = useState(() => copyPreviewMemory(projectId, boardId));
  const [sizes, setSizes] = useState<ReadonlyMap<string, Pick<Box, 'w' | 'h'>>>(() => new Map());
  const [camera, setCamera] = useState<Viewport | null>(null);
  const [selected, setSelected] = useState(rootId);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ pointer: number; startX: number; startY: number; viewport: Viewport }>();
  const branch = useMemo(() => focusBranch(nodes, edges, rootId), [nodes, edges, rootId]);
  const scene = useMemo(() => branch && layoutFocusBranch(branch, sizes, size.width), [branch, sizes, size.width]);
  const viewport = camera ?? (scene ? startViewport(scene, size) : { x: 0, y: 0, zoom: 1 });
  const latest = useRef(viewport);
  latest.current = viewport;
  const { zoom } = viewport;
  const detailLevel = heatLevel(zoom);
  const world = visibleWorldRect(viewport, size);
  const visible = { x: world.x, y: world.y, w: world.width, h: world.height };
  const heat = useMemo(() => detailLevel && scene ? aggregateHeat(scene.cards.map(({ node, box, step }) => ({
    ...node, w: box.w, h: box.h, color: step ? 'var(--focus-flow-ink)' : node.color,
  })), detailLevel) : [], [detailLevel, scene]);
  const boxes = useMemo(() => new Map(scene?.cards.map(card => [card.node.id, card.box])), [scene]);
  const cards = detailLevel ? [] : scene?.cards.filter(card => intersects(card.box, visible, 100 / zoom)) ?? [];
  const laid = useMemo(() => {
    if (!scene || detailLevel) return [];
    const bounds = visibleWorldRect(viewport, size);
    const area = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
    const edges = scene.links.filter(edge => {
      const a = boxes.get(edge.from)!, b = boxes.get(edge.to)!, control = edge.route?.control;
      const x = Math.min(a.x, b.x, control?.x ?? Infinity), y = Math.min(a.y, b.y, control?.y ?? Infinity);
      const w = Math.max(a.x + a.w, b.x + b.w, control?.x ?? -Infinity) - x;
      const h = Math.max(a.y + a.h, b.y + b.h, control?.y ?? -Infinity) - y;
      return intersects({ x, y, w, h }, area, 100 / viewport.zoom);
    });
    const endpoints = new Set(edges.flatMap(edge => [edge.from, edge.to]));
    const screen = new Map<string, Box>();
    for (const [id, box] of boxes) if (endpoints.has(id) || intersects(box, area)) {
      screen.set(id, { ...worldToScreen(viewport, box), w: box.w * viewport.zoom, h: box.h * viewport.zoom });
    }
    const routes = routeBoardEdges(screen, edges.map(edge => edge.route?.control ? {
      ...edge, route: { ...edge.route, control: worldToScreen(viewport, edge.route.control) },
    } : edge), viewport.zoom);
    return edges.flatMap(edge => {
      const route = routes.get(edge.id);
      return route ? [{ edge, route, step: scene.workflow.has(edge.id) }] : [];
    });
  }, [scene, detailLevel, viewport.x, viewport.y, zoom, size.width, size.height, boxes]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current) return;
      const rect = el.getBoundingClientRect();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setCamera(previous => zoomByFactor(previous ?? latest.current, anchor, Math.exp(-delta * 0.0015 * zoomSensitivity), MIN_BOARD_ZOOM, 3));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomSensitivity]);

  const measure = useCallback((id: string, w: number, h: number) => {
    if (!w || !h) return;
    setSizes(old => {
      const prev = old.get(id);
      return prev?.w === w && prev.h === h ? old : new Map(old).set(id, { w, h });
    });
  }, []);
  if (!scene || !branch) return null;
  const firstStep = scene.cards.find(card => card.step);
  const fitAll = () => setCamera(fitToBounds(scene.bounds, size, FIT));
  const goToStart = () => { setSelected(rootId); setCamera(startViewport(scene, size)); };
  const readCard = (id: string) => {
    const box = boxes.get(id);
    if (!box) return;
    setSelected(id);
    const preferred = Math.min(1.2, (size.width - 92) / box.w, (size.height - 118) / box.h);
    setCamera(recenter(box, size, Math.max(0.7, preferred)));
  };
  const keepCamera = () => { if (!camera) setCamera(viewport); };
  const endPan = (event: PointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div ref={host} className={`board-canvas board-branch-focus${panning ? ' is-panning' : ''}`}
    aria-label="专注视图" role="region" data-focus-root={rootId} tabIndex={0}
    style={{ ...fontStyle, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}
    onPointerDownCapture={keepCamera} onKeyDownCapture={keepCamera}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current || (event.target as Element).closest('button,.node-card')) return;
      drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, viewport };
      setPanning(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointer === event.pointerId) setCamera({ ...start.viewport, x: start.viewport.x + event.clientX - start.startX, y: start.viewport.y + event.clientY - start.startY });
    }}
    onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
    onContextMenu={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
    onKeyDown={event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('.node-card');
      if (card === event.target && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); readCard(card.dataset.nodeId!); return;
      }
      if (matchShortcut(event.nativeEvent, shortcut('fit')!)) { event.preventDefault(); fitAll(); return; }
      const factor = matchShortcut(event.nativeEvent, shortcut('zoom-in')!) ? 1.2 : matchShortcut(event.nativeEvent, shortcut('zoom-out')!) ? 1 / 1.2 : 0;
      if (factor) { event.preventDefault(); setCamera(zoomByFactor(viewport, { x: size.width / 2, y: size.height / 2 }, factor, MIN_BOARD_ZOOM, 3)); }
    }}>
    <div className="canvas-toolbar branch-focus-toolbar" role="toolbar" aria-label="专注视图工具">
      <button className="tb-btn" type="button" title="回到起点" aria-label="回到起点" onClick={goToStart}><LocateFixed size={16} aria-hidden="true"/></button>
      <button className="tb-btn" type="button" title="适配整个分支" aria-label="适配整个分支" onClick={fitAll}><Maximize size={16} aria-hidden="true"/></button>
      {firstStep && <button className="tb-btn focus-flow-jump" type="button" title="定位流程" onClick={() => readCard(firstStep.node.id)}><GitFork size={16} aria-hidden="true"/>流程</button>}
    </div>
    <svg className="edge-layer" aria-hidden="true">
      <defs>
        <marker id={`${marker}-arrow`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="var(--edge-color)"/>
        </marker>
        <marker id={`${marker}-step`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="var(--focus-flow-ink)"/>
        </marker>
      </defs>
      {laid.map(({ edge, route, step }) => <path key={edge.id} className={`edge-line${step ? ' focus-step-line' : ''}`} fill="none" d={route.d}
        data-from={edge.from} data-to={edge.to} markerEnd={edge.directed ? `url(#${marker}-${step ? 'step' : 'arrow'})` : undefined}/>) }
    </svg>
    <div className="edge-label-layer">{laid.map(({ edge, route }) => edge.label && <EdgeLabel key={edge.id} label={edge.label} x={route.labelPoint.x} y={route.labelPoint.y} zoom={zoom}/>)}</div>
    {detailLevel > 0 && <div className="heat-layer" aria-label="专注分支概览">{heat.filter(cell => intersects(cell, visible, 80 / zoom)).map(cell => {
      const point = worldToScreen(viewport, cell);
      return <button type="button" key={cell.id} className="heat-cell" aria-label={`放大包含 ${cell.count} 个节点的区域`}
        style={{ left: point.x, top: point.y, width: Math.max(9, cell.w * zoom), height: Math.max(9, cell.h * zoom), ['--heat-color' as string]: cell.color || 'var(--accent)' }}
        onClick={() => setCamera(recenter(cell, size, Math.min(1, zoom * 2)))}>{cell.count > 1 ? cell.count : ''}</button>;
    })}</div>}
    <div className="canvas-world" style={{ transform: viewportToTransform(viewport), transformOrigin: '0 0' }}>
      {cards.map(({ node, box, step }) => <div key={node.id} className={`branch-focus-card${step ? ' is-flow-step' : ''}`}
        data-focus-step={step || undefined} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onDoubleClickCapture={event => {
          if (!(event.target as HTMLElement).closest('button')) readCard(node.id);
        }}>
        <NodeCard node={{ ...node, x: 0, y: 0 }} projectId={projectId} boardId={boardId} docVersions={docVersions}
          selected={selected === node.id} editing={false} showAnchors={false} hideHandles previewMemory={memory}
          flowStep={!!node.flowOwnerId} imageWidthLimit={step || node.flowOwnerId ? Math.max(240, size.width - 100) : undefined}
          onOpen={setSelected} onPointerDown={event => event.stopPropagation()} onMeasure={measure}
          onAnchorPointerDown={noop} onResizeStart={noop} onStartEdit={noop} onContextMenu={noop} onCommit={noop} onEditCancel={noop} onExitEdit={noop} onHoverChange={noop}/>
        {step > 0 && <span className="flow-step-number" aria-label={`第 ${step} 步`}>{step}</span>}
      </div>)}
    </div>
    <output className="branch-focus-zoom" aria-label="专注视图缩放">{zoom < 0.01 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%</output>
  </div>;
}
