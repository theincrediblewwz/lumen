import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { GitFork, LocateFixed, Maximize } from 'lucide-react';
import type { BoardEdge, BoardNode } from '../api';
import { fitToBounds, viewportToTransform, visibleWorldRect, worldToScreen, zoomByFactor, type Size, type Viewport } from '../canvas/CanvasEngine';
import { useCameraMotion } from '../canvas/cameraMotion';
import { focusBranch, layoutFocusBranch, offsetFocusBranch } from '../canvas/branchFocus';
import { routeBoardEdges } from '../canvas/edgeRouting';
import type { Box, Pt } from '../canvas/geometry';
import { aggregateHeat, heatLevel, intersects, isolatedHeatLabelZoom, MIN_BOARD_ZOOM, readHeatLabel } from '../canvas/presentation';
import { matchShortcut, shortcut } from '../canvas/shortcuts';
import { EdgeLabel } from './EdgeLabel';
import { NodeCard } from './NodeCard';
import { HeatLabelText, HeatOverview } from './HeatOverview';
import { copyPreviewMemory } from './NodePreview';

const FIT = { minZoom: MIN_BOARD_ZOOM, maxZoom: 1.12, fitPadding: 52 };
const noop = () => {};
type Drag = { pointer: number; start: Pt; viewport: Viewport; moved: boolean; nodeId?: string; offset?: Pt };

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

export function BranchFocusView({ rootId, nodes, edges, projectId, boardId, docVersions, size, fontStyle, zoomSensitivity, quickMove }: {
  rootId: string; nodes: BoardNode[]; edges: BoardEdge[]; projectId: string; boardId: string;
  docVersions: Record<string, number>; size: Size; fontStyle: CSSProperties; zoomSensitivity: number; quickMove: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, '');
  useLayoutEffect(() => { host.current?.focus({ preventScroll: true }); }, []);
  const [memory] = useState(() => copyPreviewMemory(projectId, boardId));
  const [sizes, setSizes] = useState<ReadonlyMap<string, Pick<Box, 'w' | 'h'>>>(() => new Map());
  const [camera, setCamera] = useState<Viewport | null>(null);
  const [locatedHeatId, setLocatedHeatId] = useState<string | null>(null);
  const { active: cameraMotion, animate: animateCamera, cancel: cancelCamera } = useCameraMotion(rootId);
  const [selected, setSelected] = useState(rootId);
  const [dragging, setDragging] = useState(false);
  const [offsets, setOffsets] = useState<ReadonlyMap<string, Pt>>(() => new Map());
  const drag = useRef<Drag>();
  const suppressClick = useRef(false);
  const branch = useMemo(() => focusBranch(nodes, edges, rootId), [nodes, edges, rootId]);
  const layout = useMemo(() => branch && layoutFocusBranch(branch, sizes, size.width), [branch, sizes, size.width]);
  const scene = useMemo(() => layout && offsetFocusBranch(layout, offsets), [layout, offsets]);
  const viewport = camera ?? (scene ? startViewport(scene, size) : { x: 0, y: 0, zoom: 1 });
  const latest = useRef(viewport);
  latest.current = viewport;
  const paintCamera = useCallback((next: Viewport) => {
    latest.current = next;
    setCamera(next);
  }, []);
  const travel = (target: Viewport, arrived?: () => void) => {
    setLocatedHeatId(null);
    animateCamera(latest.current, target, size, paintCamera, arrived);
  };
  const { zoom } = viewport;
  const detailLevel = heatLevel(zoom);
  const world = visibleWorldRect(viewport, size);
  const visible = { x: world.x, y: world.y, w: world.width, h: world.height };
  const heatNodes = useMemo(() => scene?.cards.map(({ node, box, step }) => ({
    ...node, w: box.w, h: box.h, color: step ? 'var(--focus-flow-ink)' : node.color,
  })) ?? [], [scene]);
  const heat = useMemo(() => detailLevel ? aggregateHeat(heatNodes, detailLevel) : [], [detailLevel, heatNodes]);
  const boxes = useMemo(() => new Map(scene?.cards.map(card => [card.node.id, card.box])), [scene]);
  const cards = detailLevel ? [] : scene?.cards.filter(card => card.node.id === drag.current?.nodeId || intersects(card.box, visible, 100 / zoom)) ?? [];
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
      cancelCamera();
      setLocatedHeatId(null);
      const rect = el.getBoundingClientRect();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      paintCamera(zoomByFactor(latest.current, anchor, Math.exp(-delta * 0.0015 * zoomSensitivity), MIN_BOARD_ZOOM, 3));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [cancelCamera, paintCamera, zoomSensitivity]);

  const measure = useCallback((id: string, w: number, h: number) => {
    if (!w || !h) return;
    setSizes(old => {
      const prev = old.get(id);
      return prev?.w === w && prev.h === h ? old : new Map(old).set(id, { w, h });
    });
  }, []);
  if (!scene || !branch) return null;
  const firstStep = scene.cards.find(card => card.step);
  const fitAll = () => travel(fitToBounds(scene.bounds, size, FIT));
  const goToStart = () => { setSelected(rootId); travel(startViewport(scene, size)); };
  const readCard = (id: string, showHeatName = false) => {
    const box = boxes.get(id);
    if (!box) return;
    setSelected(id);
    const preferred = Math.min(1.2, (size.width - 92) / box.w, (size.height - 118) / box.h);
    travel(recenter(box, size, Math.max(0.7, preferred)), showHeatName ? () => setLocatedHeatId(id) : undefined);
  };
  const locate = (id: string, grouped: boolean) => {
    const box = boxes.get(id);
    if (!box) return;
    const isolated = grouped && isolatedHeatLabelZoom(heatNodes, id, zoom);
    if (isolated) travel(recenter(box, size, isolated));
    else readCard(id, true);
  };
  const located = !detailLevel && locatedHeatId ? scene.cards.find(card => card.node.id === locatedHeatId) : undefined;
  const locatedName = readHeatLabel(located?.node.heatLabel);
  const locatedAt = located ? worldToScreen(viewport, { x: located.box.x + located.box.w / 2, y: located.box.y }) : undefined;
  const keepCamera = () => { if (!camera) setCamera(viewport); };
  const moveCard = (id: string, offset: Pt) => {
    setOffsets(previous => {
      const point = previous.get(id);
      if ((point?.x ?? 0) === offset.x && (point?.y ?? 0) === offset.y) return previous;
      const next = new Map(previous);
      if (offset.x || offset.y) next.set(id, offset);
      else next.delete(id);
      return next;
    });
  };
  const startDrag = (event: PointerEvent, id?: string) => {
    if (!event.isPrimary || event.button !== 0 || event.ctrlKey || drag.current) return;
    if ((event.target as Element).closest('button, input, textarea, select, a, [contenteditable]')) return;
    cancelCamera();
    setLocatedHeatId(null);
    const nodeId = quickMove || selected === id ? id : undefined;
    event.preventDefault();
    drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, viewport: latest.current, moved: false,
      nodeId, offset: nodeId ? offsets.get(nodeId) ?? { x: 0, y: 0 } : undefined };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = event.clientX - d.start.x, dy = event.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    if (d.nodeId && d.offset) {
      const zoom = d.viewport.zoom;
      moveCard(d.nodeId, { x: d.offset.x + dx / zoom, y: d.offset.y + dy / zoom });
    } else {
      paintCamera({ ...d.viewport, x: d.viewport.x + dx, y: d.viewport.y + dy });
    }
  };
  const endDrag = (event: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    if (event.type === 'pointerup') moveDrag(event);
    else if (d.moved && d.nodeId && d.offset) moveCard(d.nodeId, d.offset);
    suppressClick.current = d.moved;
    drag.current = undefined;
    setDragging(false);
  };
  const stopDragClick = (event: React.MouseEvent) => {
    if (event.detail && suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
  };

  return <div ref={host} className={`board-canvas board-branch-focus${dragging ? ' is-panning' : ''}${quickMove ? ' is-quick-move' : ''}`}
    data-detail-view={!detailLevel || undefined}
    aria-label="专注视图" role="region" data-focus-root={rootId} tabIndex={0}
    style={{ ...fontStyle, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}
    onPointerDownCapture={() => { suppressClick.current = false; keepCamera(); }} onKeyDownCapture={keepCamera}
    onPointerDown={event => startDrag(event)} onPointerMove={moveDrag}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onClickCapture={stopDragClick} onDoubleClickCapture={stopDragClick}
    onContextMenu={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}
    onKeyDown={event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('.node-card');
      if (card === event.target && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); readCard(card.dataset.nodeId!); return;
      }
      if (matchShortcut(event.nativeEvent, shortcut('fit')!)) { event.preventDefault(); fitAll(); return; }
      const factor = matchShortcut(event.nativeEvent, shortcut('zoom-in')!) ? 1.2 : matchShortcut(event.nativeEvent, shortcut('zoom-out')!) ? 1 / 1.2 : 0;
      if (factor) {
        event.preventDefault();
        const pending = cameraMotion.current?.target ?? latest.current;
        travel(zoomByFactor(pending, { x: size.width / 2, y: size.height / 2 }, factor, MIN_BOARD_ZOOM, 3));
      }
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
    {detailLevel > 0 && <HeatOverview key={detailLevel} cells={heat.filter(cell => intersects(cell, visible, 80 / zoom))}
      level={detailLevel} viewport={viewport} description="专注分支概览" onLocate={locate}
      onExpand={cell => travel(recenter(cell, size, Math.min(1, (cameraMotion.current?.target.zoom ?? zoom) * 2)))} />}
    {locatedAt && locatedName && <div className="heat-label-destination" style={{ left: locatedAt.x, top: locatedAt.y }}>
      <HeatLabelText label={locatedName}/>
    </div>}
    <div className="canvas-world" style={{ transform: viewportToTransform(viewport), transformOrigin: '0 0', ['--image-pager-scale' as string]: 1 / Math.min(zoom, 1) }}>
      {cards.map(({ node, box, step }) => <div key={node.id} className={`branch-focus-card${step ? ' is-flow-step' : ''}`}
        data-focus-step={step || undefined} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onDoubleClickCapture={event => {
          if (!(event.target as HTMLElement).closest('button')) readCard(node.id);
        }}>
        <NodeCard node={{ ...node, x: 0, y: 0 }} projectId={projectId} boardId={boardId} docVersions={docVersions}
          selected={selected === node.id} editing={false} showAnchors={false} hideHandles previewMemory={memory}
          flowStep={!!node.flowOwnerId} imageWidthLimit={step || node.flowOwnerId ? Math.max(240, size.width - 100) : undefined}
          onOpen={setSelected} onPointerDown={event => { event.stopPropagation(); startDrag(event, node.id); }} onMeasure={measure}
          onAnchorPointerDown={noop} onResizeStart={noop} onStartEdit={noop} onContextMenu={noop} onCommit={noop} onEditCancel={noop} onExitEdit={noop} onHoverChange={noop}/>
        {step > 0 && <span className="flow-step-number" aria-label={`第 ${step} 步`}>{step}</span>}
      </div>)}
    </div>
    <output className="branch-focus-zoom" aria-label="专注视图缩放">{zoom < 0.01 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%</output>
  </div>;
}
