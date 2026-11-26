import { Check, Plus, Sparkles, Star, X } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { BoardMeta, Viewport } from '../api';
import { fitToBounds, IDENTITY_VIEWPORT, screenToWorld, worldToScreen, zoomByFactor, type Vec2 } from '../canvas/CanvasEngine';
import { useCameraMotion } from '../canvas/cameraMotion';
import { straightPath } from '../canvas/geometry';
import { coverPreset } from '../projectCanvas/coverPresets';
import { cardBounds, translate } from '../projectCanvas/expansion';
import { relationEndpoint, TILE_HEIGHT, TILE_WIDTH, type CatalogTile, type ProjectRelation, type RelationBend } from '../projectCanvas/layout';
import { bendAt, projectPort, relationGeometry, relationKey, relationLabelPoint, spaceBetweenCards, type ProjectBox } from '../projectCanvas/relations';
import type { CatalogTag } from '../projectCanvas/tags';
import { tileKey, useExpansion } from '../projectCanvas/useExpansion';
import { EdgeLabel } from './EdgeLabel';
import { TagDots } from './CatalogTags';
import { ProjectTileArtwork } from './ProjectTileArtwork';
import '../projectCanvas/projectCanvas.css';

type Drag = {
  pointer: number;
  start: Vec2;
  view: Viewport;
  tile?: CatalogTile;
  from?: string;
  relation?: { edge: ProjectRelation; grip: Vec2 };
  position?: Vec2;
  target?: string;
  moved: boolean;
};

type Props = {
  scope: string;
  folderId: string | null;
  folderName?: string;
  tiles: CatalogTile[];
  relations?: ProjectRelation[];
  tags: CatalogTag[];
  filtering: boolean;
  disabled: boolean;
  readBoards: (projectId: string) => Promise<BoardMeta[]>;
  previewTiles: (projectId: string, boards: BoardMeta[]) => CatalogTile[];
  onOpen: (tile: CatalogTile) => void;
  onPlace: (tile: CatalogTile, point: Vec2, target?: string) => Promise<void>;
  onConnect: (relation: ProjectRelation) => void;
  onBend: (relation: ProjectRelation, bend: RelationBend | null) => Promise<void>;
  onLabel: (relation: ProjectRelation, label: string) => Promise<void>;
  onRelationMenu: (event: MouseEvent, relation: ProjectRelation) => void;
  onFavorite: (tile: CatalogTile) => void;
  onMenu: (event: MouseEvent, tile?: CatalogTile) => void;
  addMenuOpen: boolean;
  onAdd: (event: MouseEvent) => void;
  onWorkspaceAi: () => void;
};

function folderBox(position: Vec2): ProjectBox {
  return { x: position.x + 23, y: position.y + 25, w: 108, h: 55, folder: true };
}

function tileBox(tile: CatalogTile, position: Vec2): ProjectBox {
  return tile.kind === 'project' ? folderBox(position) : { x: position.x + 12, y: position.y + 8, w: 130, h: 74 };
}

function previewSpoke(parent: ProjectBox, tile: CatalogTile, position: Vec2) {
  const child = tileBox(tile, position);
  const geometry = relationGeometry(parent, child);
  return spaceBetweenCards(parent, child, geometry) ? geometry : null;
}

function RelationName({ relation, point, width, height, onClose, onSave }: {
  relation: ProjectRelation; point: Vec2; width: number; height: number;
  onClose: () => void; onSave: (label: string) => Promise<void>;
}) {
  const [name, setName] = useState(relation.label ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  const x = Math.min(Math.max(point.x, 158), Math.max(158, width - 158));
  const y = Math.min(Math.max(point.y, 23), Math.max(23, height - 55));
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(name);
      onClose();
    } catch (error) {
      setError(String(error).replace(/^Error:\s*/, ''));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return <form className="project-relation-editor" style={{ left: x, top: y }} onPointerDown={event => event.stopPropagation()}
    onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && !pending.current) { event.stopPropagation(); onClose(); }
    }}>
    <div>
      <input ref={input} autoFocus className="input" aria-label="项目连线名称" placeholder="连线名称，支持公式"
        value={name} maxLength={240} disabled={saving} onChange={event => setName(event.target.value)} />
      <button type="submit" aria-label="保存连线名称" disabled={saving}><Check size={16} /></button>
      <button type="button" aria-label="取消编辑连线名称" disabled={saving} onClick={onClose}><X size={16} /></button>
    </div>
    {error && <p className="catalog-tag-error" role="alert">{error}</p>}
  </form>;
}

const TileContent = memo(function TileContent({ tile, tags, drop }: { tile: CatalogTile; tags: CatalogTag[]; drop?: string }) {
  return <>
    <span className="project-tile-visual" aria-hidden="true" data-drop-project={drop}>
      <ProjectTileArtwork kind={tile.kind} cover={coverPreset(tile.coverId)} />
    </span>
    <span className="project-tile-title">{tile.row.name}</span>
    <TagDots tags={tags.filter(tag => tile.tagIds.includes(tag.id))} />
  </>;
});

export function ProjectCanvas({ scope, folderId, folderName, tiles, relations, tags, filtering, disabled, readBoards, previewTiles, onOpen, onPlace, onConnect, onBend, onLabel, onRelationMenu, onFavorite, onMenu, addMenuOpen, onAdd, onWorkspaceAi }: Props) {
  const element = useRef<HTMLElement>(null);
  const { viewport, view, setView, takeCamera, persistView, expanded, scene, toggle, close } = useExpansion({
    host: element, scope, folderId, tiles, readBoards, previewTiles,
  });
  const { animate: animateCamera, cancel: cancelCamera } = useCameraMotion(folderId ?? scope);
  const wheelSave = useRef(0);
  const gesture = useRef<Drag>();
  const suppressClick = useRef(false);
  const marker = useId();
  const [dragged, setDragged] = useState<{ id?: string; kind?: CatalogTile['kind']; position?: Vec2; target?: string }>();
  const [connection, setConnection] = useState<{ from: string; point: Vec2; target?: string }>();
  const [bending, setBending] = useState<{ key: string; bend: RelationBend | null }>();
  const [editingName, setEditingName] = useState<string>();

  function tilePosition(tile: CatalogTile) {
    const point = dragged?.id === tile.row.id && dragged.kind === tile.kind
      ? dragged.position ?? tile.position
      : tile.position;
    const offset = scene.offsets.get(tileKey(tile));
    return offset ? translate(point, offset) : point;
  }

  const endpoints = new Map(tiles.map(tile => [
    relationEndpoint(tile), { name: tile.row.name, position: tile.position, box: tileBox(tile, tilePosition(tile)) },
  ]));
  const draggingFolder = dragged?.kind === 'project' && dragged.id ? endpoints.get(dragged.id) : undefined;
  const dragOffset = draggingFolder && dragged?.position ? {
    x: dragged.position.x - draggingFolder.position.x, y: dragged.position.y - draggingFolder.position.y,
  } : undefined;
  const branches = scene.branches.map(branch => dragOffset && branch.root === dragged?.id
    ? { ...branch, point: translate(branch.point, dragOffset) } : branch);
  const relationIndex = new Map((relations ?? []).map(edge => [relationKey(edge), edge]));
  function layRelation(relation: ProjectRelation, from: { name: string; box: ProjectBox }, to: { name: string; box: ProjectBox }, preview = false) {
    const key = relationKey(relation);
    const bend = !preview && bending?.key === key ? bending.bend : relation.bend;
    const reverse = relationIndex.get(relationKey({ from: relation.to, to: relation.from }));
    const separation = reverse && !reverse.bend ? 8 / viewport.zoom : 0;
    const geometry = relationGeometry(from.box, to.box, bend, separation);
    return { relation, key, name: `${from.name} → ${to.name}`, geometry, labelPoint: relationLabelPoint(geometry, from.box, to.box, relation.label) };
  }
  const laidRelations = (relations ?? []).flatMap(relation => {
    const from = endpoints.get(relation.from), to = endpoints.get(relation.to);
    return from && to ? [layRelation(relation, from, to)] : [];
  });
  const projected = new Map(branches.map(branch => [relationEndpoint(branch.tile), {
    owner: branch.owner, name: branch.tile.row.name, box: tileBox(branch.tile, branch.point), opacity: branch.opacity,
  }]));
  const previewRelations = branches.length ? (relations ?? []).flatMap(relation => {
    const from = projected.get(relation.from), to = projected.get(relation.to);
    if (!from || !to || from.owner !== to.owner || !spaceBetweenCards(from.box, to.box, relationGeometry(from.box, to.box))) return [];
    return [{ ...layRelation(relation, from, to, true), owner: from.owner, opacity: Math.min(from.opacity, to.opacity) }];
  }) : [];
  const named = laidRelations.find(edge => edge.key === editingName);

  function clickTile(event: MouseEvent<HTMLButtonElement>, tile: CatalogTile, owner?: string) {
    if (event.detail > 0 && suppressClick.current) return;
    cancelCamera();
    if (tile.kind === 'board' || event.detail === 0) onOpen(tile);
    else if (event.detail === 1) toggle(tile.row.id, owner);
  }

  function tileKeyDown(event: KeyboardEvent<HTMLButtonElement>, tile: CatalogTile, owner?: string) {
    if (tile.kind === 'project' && event.key === ' ') {
      event.preventDefault();
      cancelCamera();
      if (!event.repeat) toggle(tile.row.id, owner);
    } else if (owner === undefined && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    }
  }

  function previewStatus(message?: string) {
    return message !== undefined && <span className="project-preview-status" role="status">
      {message || (filtering ? '此项目中没有匹配的内容' : '此项目为空')}
    </span>;
  }

  useEffect(() => {
    const host = element.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (disabled || gesture.current) return;
      cancelCamera();
      const rect = host.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      setView(zoomByFactor(view.current, anchor, Math.exp(-delta * 0.0015), 0.15, 2.5));
      window.clearTimeout(wheelSave.current);
      wheelSave.current = window.setTimeout(persistView, 160);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [persistView, disabled, cancelCamera]);

  useEffect(() => () => {
    window.clearTimeout(wheelSave.current);
  }, []);

  function begin(event: PointerEvent<HTMLElement>) {
    if (disabled || gesture.current || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    cancelCamera();
    suppressClick.current = false;
    const hit = event.target as Element;
    if (event.button === 0 && hit.closest('.project-preview-open')) return;
    const line = hit.closest<SVGElement>('[data-relation-key]');
    if (line) {
      if (event.button !== 0) return;
      const relation = laidRelations.find(edge => edge.key === line.dataset.relationKey);
      if (!relation) return;
      gesture.current = {
        pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, view: view.current,
        relation: { edge: relation.relation, grip: relation.geometry.mid }, moved: false,
      };
      return;
    }
    const port = hit.closest<HTMLButtonElement>('[data-connect-card]');
    if (port) {
      if (event.button !== 0) return;
      gesture.current = {
        pointer: event.pointerId, start: { x: event.clientX, y: event.clientY },
        view: view.current, from: port.dataset.connectCard, moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const button = hit.closest<HTMLButtonElement>('.project-tile-open');
    if (hit.closest('button, .project-relation-hit') && !button) return;
    const tile = event.button === 0 && button
      ? tiles.find(row => row.row.id === button.dataset.id && row.kind === button.dataset.kind)
      : undefined;
    gesture.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, view: view.current, tile, moved: false };
    if (!tile) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function connectionPoint(event: PointerEvent<HTMLElement>, from: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = screenToWorld(view.current, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const tile = hit?.closest<HTMLElement>('.project-tile');
    const direct = tile?.dataset.relationEndpoint;
    if (tile || !hit || !event.currentTarget.contains(hit) || hit.closest('button')) {
      return { from, point, target: direct !== from && direct && endpoints.has(direct) ? direct : undefined };
    }
    // A small margin in screen pixels keeps the drop forgiving at any zoom.
    let target: string | undefined;
    let nearest = 12 / view.current.zoom;
    for (const [id, { box }] of endpoints) {
      if (id === from) continue;
      const distance = Math.hypot(
        Math.max(box.x - point.x, point.x - box.x - box.w, 0),
        Math.max(box.y - point.y, point.y - box.y - box.h, 0),
      );
      if (distance <= nearest) {
        target = id;
        nearest = distance;
      }
    }
    return { from, point, target };
  }

  function bendDuringDrag(drag: Drag, event: PointerEvent<HTMLElement>) {
    if (!drag.relation) return null;
    const { edge, grip } = drag.relation;
    const from = endpoints.get(edge.from)?.box, to = endpoints.get(edge.to)?.box;
    if (!from || !to) return null;
    const point = {
      x: grip.x + (event.clientX - drag.start.x) / drag.view.zoom,
      y: grip.y + (event.clientY - drag.start.y) / drag.view.zoom,
    };
    return { key: relationKey(edge), bend: bendAt(from, to, point, view.current.zoom) };
  }

  function track(event: PointerEvent<HTMLElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId || disabled) return;
    const dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      takeCamera();
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (drag.from) {
      setConnection(connectionPoint(event, drag.from));
      return;
    }
    if (drag.relation) {
      const draft = bendDuringDrag(drag, event);
      if (draft) setBending(draft);
      return;
    }
    if (!drag.tile) {
      setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
      setDragged({});
      return;
    }
    drag.position = {
      x: Math.round(drag.tile.position.x + dx / drag.view.zoom),
      y: Math.round(drag.tile.position.y + dy / drag.view.zoom),
    };
    const target = drag.tile.kind === 'project'
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-drop-project]')
      : null;
    const targetId = target?.dataset.dropProject;
    drag.target = targetId !== drag.tile.row.id ? targetId : undefined;
    setDragged({ id: drag.tile.row.id, kind: drag.tile.kind, position: drag.position, target: drag.target });
  }

  function end(event: PointerEvent<HTMLElement>, cancel = false) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.relation) {
      const draft = drag.moved && !cancel && !disabled ? bendDuringDrag(drag, event) : null;
      if (draft) {
        setBending(draft);
        void onBend(drag.relation.edge, draft.bend).finally(() => setBending(undefined));
      } else setBending(undefined);
      return;
    }
    if (drag.from) {
      setConnection(undefined);
      if (drag.moved && !cancel && !disabled) {
        const { target } = connectionPoint(event, drag.from);
        if (target) onConnect({ from: drag.from, to: target });
      }
      return;
    }
    if (!drag.moved || cancel || disabled) {
      if (!drag.tile && drag.moved) setView(drag.view);
      setDragged(undefined);
      return;
    }
    if (drag.tile && drag.position) {
      void onPlace(drag.tile, drag.position, drag.target).finally(() => setDragged(undefined));
    } else {
      persistView();
      setDragged(undefined);
    }
  }

  function fit() {
    const host = element.current!;
    const box = cardBounds([...tiles.map(tilePosition), ...branches.map(branch => branch.point)]);
    const next = box
      ? fitToBounds(
        box,
        { width: host.clientWidth, height: host.clientHeight },
        { minZoom: 0.15, maxZoom: 1, fitPadding: 52 },
      )
      : { ...IDENTITY_VIEWPORT };
    takeCamera();
    animateCamera(view.current, next, { width: host.clientWidth, height: host.clientHeight }, setView, persistView);
  }

  const sourceBox = connection && endpoints.get(connection.from)?.box;
  const targetBox = connection?.target ? endpoints.get(connection.target)?.box : undefined;
  const draftPath = connection && sourceBox && (targetBox
    ? relationGeometry(sourceBox, targetBox).d
    : straightPath(projectPort(sourceBox, connection.point), connection.point));

  return (
    <main
      ref={element} className={`board-canvas project-canvas${dragged ? ' is-dragging' : ''}${connection ? ' is-connecting' : ''}${bending ? ' is-bending' : ''}`}
      aria-label={folderName ? `${folderName}的项目画布` : '项目首页画布'}
      data-folder-id={folderId ?? ''} data-zoom={viewport.zoom}
      style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${26 * viewport.zoom}px ${26 * viewport.zoom}px` }}
      onPointerDown={begin} onPointerMove={track} onPointerUp={event => end(event)}
      onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}
      onKeyDown={event => {
        if (event.key === 'Escape' && (gesture.current?.from || gesture.current?.relation)) {
          const { pointer } = gesture.current;
          gesture.current = undefined;
          if (event.currentTarget.hasPointerCapture(pointer)) event.currentTarget.releasePointerCapture(pointer);
          setConnection(undefined);
          setBending(undefined);
        } else if (event.key === 'Escape' && expanded.size && !editingName && !disabled) {
          event.stopPropagation();
          close();
        }
      }}
      onContextMenu={event => { if (!disabled) onMenu(event); }}
      onScroll={event => { if (event.target === event.currentTarget) { event.currentTarget.scrollTop = 0; event.currentTarget.scrollLeft = 0; } }}
    >
      <div className="project-canvas-world" style={{ transform: `translate3d(${viewport.x}px,${viewport.y}px,0) scale(${viewport.zoom})` }}>
        <svg className="project-relations">
          <defs>
            <marker id={marker} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" viewBox="0 0 10 10" refX="9" refY="5" orient="auto">
              <path d="M 1 1 L 9 5 L 1 9 Z" fill="currentColor" />
            </marker>
          </defs>
          {branches.map(({ owner, tile, origin, point, opacity }) => {
            const parent = endpoints.get(owner)?.box ?? projected.get(owner)?.box ?? folderBox(origin);
            const spoke = previewSpoke(parent, tile, point);
            return spoke && <line key={`${owner}:${tileKey(tile)}`} className="project-preview-spoke" aria-hidden="true"
              data-preview-child={relationEndpoint(tile)} x1={spoke.start.x} y1={spoke.start.y} x2={spoke.end.x} y2={spoke.end.y} opacity={opacity} />;
          })}
          {previewRelations.map(({ owner, key, name, relation, geometry, opacity }) => (
            <path key={`${owner}:${key}`} className="project-relation-line project-preview-arrow" d={geometry.d}
              data-from={relation.from} data-to={relation.to} data-preview-owner={owner}
              style={{ opacity }} markerEnd={`url(#${marker})`} role="img" aria-label={name}><title>{name}</title></path>
          ))}
          {laidRelations.map(({ key, relation, geometry: { d, mid }, name }) => {
            return (
              <g key={key} className={`project-relation${bending?.key === key ? ' is-bending' : ''}`} data-from={relation.from} data-to={relation.to}>
                <path className="project-relation-line" d={d} markerEnd={`url(#${marker})`} aria-hidden="true" />
                <path
                  className="project-relation-hit" d={d} role="button" tabIndex={disabled ? -1 : 0}
                  aria-label={name} aria-disabled={disabled} data-relation-key={key}
                  onClick={event => {
                    if (!disabled && (!suppressClick.current || event.detail === 0)) { event.stopPropagation(); setEditingName(key); }
                  }}
                  onContextMenu={event => { if (!disabled) onRelationMenu(event, relation); }}
                  onKeyDown={event => {
                    if (disabled) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault(); setEditingName(key);
                    }
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      event.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                    }
                  }}
                ><title>{name} · 拖动调整弯折</title></path>
                <circle className="project-relation-handle" data-relation-key={key} aria-hidden="true"
                  cx={mid.x} cy={mid.y} r={6 / viewport.zoom} />
              </g>
            );
          })}
          {draftPath && <path className="project-relation-line project-relation-draft" d={draftPath} markerEnd={`url(#${marker})`} aria-hidden="true" />}
        </svg>
        {tiles.map(tile => {
          const moving = dragged?.id === tile.row.id && dragged.kind === tile.kind;
          const point = tilePosition(tile);
          const folder = tile.kind === 'project';
          const isExpanded = folder && expanded.has(tile.row.id);
          const message = isExpanded ? expanded.get(tile.row.id) : undefined;
          const endpoint = relationEndpoint(tile);
          return (
            <div
              key={tileKey(tile)}
              className={`project-tile is-${tile.kind}${isExpanded ? ' is-expanded' : ''}${moving ? ' is-moving' : ''}${dragged?.target === tile.row.id && folder ? ' is-drop-project' : ''}${connection?.target === endpoint ? ' is-connection-target' : ''}${tile.favorite ? ' is-favorite' : ''}`}
              style={{ transform: `translate3d(${point.x}px,${point.y}px,0)`, width: TILE_WIDTH, minHeight: TILE_HEIGHT }}
              data-relation-endpoint={endpoint}
              onContextMenu={event => { if (!disabled) onMenu(event, tile); }}
            >
              <button
                type="button" disabled={disabled} className="project-tile-open"
                data-kind={tile.kind} data-id={tile.row.id}
                aria-label={tile.row.name} aria-expanded={folder ? isExpanded : undefined}
                aria-busy={message === '正在读取…' ? true : undefined}
                title={folder ? `${tile.row.name} · 单击预览 · 双击进入` : tile.row.name}
                onClick={event => clickTile(event, tile)}
                onDoubleClick={() => { if (folder && !suppressClick.current) onOpen(tile); }}
                onKeyDown={event => tileKeyDown(event, tile)}
              >
                <TileContent tile={tile} tags={tags} drop={folder ? tile.row.id : undefined} />
              </button>
              <button
                type="button" disabled={disabled} className="project-connect-port" data-connect-card={endpoint}
                aria-label={`从${tile.row.name}拉出${folder ? '项目' : '白板'}连线`} title="拖到同层的项目或白板建立连线"
                onClick={event => { if (event.detail === 0) onMenu(event, tile); }}
              ><span aria-hidden="true" /></button>
              <button
                type="button" disabled={disabled} className="project-tile-star" aria-pressed={tile.favorite}
                aria-label={`收藏置顶${folder ? '项目' : '白板'}：${tile.row.name}`}
                title={tile.favorite ? '取消收藏' : '收藏并置顶'} onClick={() => onFavorite(tile)}
              ><Star size={15} fill={tile.favorite ? 'currentColor' : 'none'} /></button>
              {previewStatus(message)}
            </div>
          );
        })}
        {branches.map(({ owner, tile, point, opacity, retiring }) => {
          const shown = expanded.has(owner) && !retiring && opacity >= 0.72;
          const folder = tile.kind === 'project';
          const isExpanded = shown && folder && expanded.has(tile.row.id);
          const message = isExpanded ? expanded.get(tile.row.id) : undefined;
          return <div key={`${owner}:${tileKey(tile)}`} className={`project-tile is-${tile.kind} is-preview-tile${isExpanded ? ' is-expanded' : ''}`}
            style={{ transform: `translate3d(${point.x}px,${point.y}px,0)`, width: TILE_WIDTH, minHeight: TILE_HEIGHT, opacity }}
            data-preview-owner={owner} data-preview-endpoint={relationEndpoint(tile)} aria-hidden={!shown}>
            <button type="button" className="project-tile-open project-preview-open" data-id={tile.row.id} disabled={disabled || !shown}
              aria-label={tile.row.name} aria-expanded={folder ? isExpanded : undefined} aria-busy={message === '正在读取…' ? true : undefined}
              title={folder ? `${tile.row.name} · 单击预览 · 双击进入` : tile.row.name}
              onPointerDown={event => { if (event.button === 0) suppressClick.current = false; }}
              onClick={event => clickTile(event, tile, owner)}
              onDoubleClick={() => { if (folder) onOpen(tile); }}
              onKeyDown={event => tileKeyDown(event, tile, owner)}
              onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
              <TileContent tile={tile} tags={tags} />
            </button>
            {previewStatus(message)}
          </div>;
        })}
      </div>
      <div className="edge-label-layer project-relation-names">
        {previewRelations.map(({ owner, key, relation, labelPoint, opacity }) => {
          if (!relation.label || opacity < 0.55) return null;
          const at = worldToScreen(viewport, labelPoint);
          return <div key={`${owner}:${key}`} data-preview-label={owner} style={{ opacity }}>
            <EdgeLabel label={relation.label} x={at.x} y={at.y} zoom={viewport.zoom} />
          </div>;
        })}
        {laidRelations.map(({ key, relation, labelPoint, geometry }) => {
          if (!relation.label || key === editingName) return null;
          const { x, y } = worldToScreen(viewport, labelPoint);
          const edit = () => { if (!disabled) setEditingName(key); };
          return <div key={key} onContextMenu={event => { if (!disabled) onRelationMenu(event, relation); }}>
            <EdgeLabel label={relation.label} x={x} y={y - (bending?.key === key && geometry.mid === labelPoint ? 22 : 0)} zoom={viewport.zoom} onSelect={edit} onEdit={edit} />
          </div>;
        })}
        {named && <RelationName key={named.key} relation={named.relation} point={worldToScreen(viewport, named.geometry.mid)}
          width={element.current?.clientWidth ?? 720} height={element.current?.clientHeight ?? 480}
          onSave={label => onLabel(named.relation, label)} onClose={() => setEditingName(undefined)} />}
      </div>
      {!tiles.length && <p className="project-canvas-empty">{filtering ? '当前没有匹配标签的内容' : folderId ? '此项目为空' : '新建一个项目开始'}</p>}
      <button className="project-canvas-fit" type="button" title="显示全部" aria-label={`显示全部 · 当前缩放 ${Math.round(viewport.zoom * 100)}%`} onClick={fit}>
        {Math.round(viewport.zoom * 100)}%
      </button>
      <div className="project-canvas-actions">
        <button type="button" className="project-canvas-ai" disabled={disabled} onClick={onWorkspaceAi}>
          <Sparkles size={17} aria-hidden="true" />AI 工作区
        </button>
        <button className="project-canvas-add" type="button" title={folderId ? '新建' : '新建项目'} aria-label={folderId ? '新建' : '新建项目'}
          aria-haspopup={folderId ? 'menu' : undefined} aria-expanded={folderId ? addMenuOpen : undefined} disabled={disabled} onClick={onAdd}>
          <Plus size={24} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}
