import { Check, Plus, Sparkles, Star, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { Viewport } from '../api';
import { fitToBounds, IDENTITY_VIEWPORT, screenToWorld, worldToScreen, zoomByFactor, type Vec2 } from '../canvas/CanvasEngine';
import { bentGeometry, borderPoint, edgeGeometry, straightPath, type Box } from '../canvas/geometry';
import { coverPreset } from '../projectCanvas/coverPresets';
import { readProjectView, saveProjectView, TILE_HEIGHT, TILE_WIDTH, type CatalogTile, type ProjectRelation } from '../projectCanvas/layout';
import type { CatalogTag } from '../projectCanvas/tags';
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
  onOpen: (tile: CatalogTile) => void;
  onPlace: (tile: CatalogTile, point: Vec2, target?: string) => Promise<void>;
  onConnect: (relation: ProjectRelation) => void;
  onLabel: (relation: ProjectRelation, label: string) => Promise<void>;
  onRelationMenu: (event: MouseEvent, relation: ProjectRelation) => void;
  onFavorite: (tile: CatalogTile) => void;
  onMenu: (event: MouseEvent, tile?: CatalogTile) => void;
  onAdd: (event: MouseEvent) => void;
  onWorkspaceAi: () => void;
};

// Include the folder tab so arrowheads stay visible above the icon.
function folderBox(position: Vec2): Box {
  return { x: position.x + 22, y: position.y + 10, w: 110, h: 71 };
}

function namedGeometry(from: Box, to: Box, label?: string) {
  const curve = edgeGeometry(from, to);
  if (!label) return curve;
  const { x, y } = curve.mid;
  const halfWidth = Math.min(180, Array.from(label).length * 4.8);
  const coversFolder = (box: Box) => x + halfWidth > box.x && x - halfWidth < box.x + box.w
    && y + 11 > box.y && y - 11 < box.y + box.h;
  if (!coversFolder(from) && !coversFolder(to)) return curve;
  if (Math.abs(from.x - to.x) >= Math.abs(from.y - to.y)) {
    const outsideY = from.x <= to.x ? Math.min(from.y, to.y) - 22 : Math.max(from.y, to.y) + from.h + 25;
    return bentGeometry(from, to, { x, y: outsideY });
  }
  const outsideX = from.y <= to.y ? Math.max(from.x, to.x) + from.w + halfWidth + 10 : Math.min(from.x, to.x) - halfWidth - 10;
  return bentGeometry(from, to, { x: outsideX, y });
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

export function ProjectCanvas({ scope, folderId, folderName, tiles, relations, tags, filtering, disabled, onOpen, onPlace, onConnect, onLabel, onRelationMenu, onFavorite, onMenu, onAdd, onWorkspaceAi }: Props) {
  const element = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState(() => readProjectView(scope, folderId));
  const view = useRef(viewport);
  const wheelSave = useRef(0);
  const gesture = useRef<Drag>();
  const suppressClick = useRef(false);
  const marker = useId();
  const [dragged, setDragged] = useState<{ id?: string; kind?: CatalogTile['kind']; position?: Vec2; target?: string }>();
  const [connection, setConnection] = useState<{ from: string; point: Vec2; target?: string }>();
  const [editingName, setEditingName] = useState<string>();

  function tilePosition(tile: CatalogTile) {
    return dragged?.id === tile.row.id && dragged.kind === tile.kind
      ? dragged.position ?? tile.position
      : tile.position;
  }

  const folders = new Map(tiles.filter(tile => tile.kind === 'project').map(tile => [
    tile.row.id, { name: tile.row.name, box: folderBox(tilePosition(tile)) },
  ]));
  const laidRelations = (relations ?? []).flatMap(relation => {
    const from = folders.get(relation.from), to = folders.get(relation.to);
    return from && to ? [{
      relation, key: `${relation.from}:${relation.to}`,
      name: `${from.name} → ${to.name}`, geometry: namedGeometry(from.box, to.box, relation.label),
    }] : [];
  });
  const named = laidRelations.find(edge => edge.key === editingName);

  function setView(next: Viewport) {
    view.current = next;
    setViewport(next);
  }

  useEffect(() => {
    const host = element.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (disabled || gesture.current) return;
      const rect = host.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      setView(zoomByFactor(view.current, anchor, Math.exp(-delta * 0.0015), 0.15, 2.5));
      window.clearTimeout(wheelSave.current);
      wheelSave.current = window.setTimeout(() => saveProjectView(scope, folderId, view.current), 160);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [scope, folderId, disabled]);

  useEffect(() => () => {
    window.clearTimeout(wheelSave.current);
    saveProjectView(scope, folderId, view.current);
  }, [scope, folderId]);

  function begin(event: PointerEvent<HTMLElement>) {
    if (disabled || gesture.current || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    suppressClick.current = false;
    const hit = event.target as Element;
    const port = hit.closest<HTMLButtonElement>('[data-connect-project]');
    if (port) {
      if (event.button !== 0) return;
      gesture.current = {
        pointer: event.pointerId, start: { x: event.clientX, y: event.clientY },
        view: view.current, from: port.dataset.connectProject, moved: false,
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
    const direct = tile?.dataset.projectFolder;
    if (tile || !hit || !event.currentTarget.contains(hit) || hit.closest('button')) {
      return { from, point, target: direct !== from && direct && folders.has(direct) ? direct : undefined };
    }
    // A small margin in screen pixels keeps the drop forgiving at any zoom.
    let target: string | undefined;
    let nearest = 12 / view.current.zoom;
    for (const [id, { box }] of folders) {
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

  function track(event: PointerEvent<HTMLElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId || disabled) return;
    const dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (drag.from) {
      setConnection(connectionPoint(event, drag.from));
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
      saveProjectView(scope, folderId, view.current);
      setDragged(undefined);
    }
  }

  function fit() {
    const host = element.current!;
    const box = tiles.reduce<{ x: number; y: number; right: number; bottom: number } | null>((area, { position: p }) => ({
      x: Math.min(p.x, area?.x ?? p.x),
      y: Math.min(p.y, area?.y ?? p.y),
      right: Math.max(p.x + TILE_WIDTH, area?.right ?? p.x + TILE_WIDTH),
      bottom: Math.max(p.y + TILE_HEIGHT, area?.bottom ?? p.y + TILE_HEIGHT),
    }), null);
    const next = box
      ? fitToBounds(
        { x: box.x, y: box.y, width: box.right - box.x, height: box.bottom - box.y },
        { width: host.clientWidth, height: host.clientHeight },
        { minZoom: 0.15, maxZoom: 1, fitPadding: 52 },
      )
      : { ...IDENTITY_VIEWPORT };
    setView(next);
    saveProjectView(scope, folderId, next);
  }

  const sourceBox = connection && folders.get(connection.from)?.box;
  const targetBox = connection?.target ? folders.get(connection.target)?.box : undefined;
  const draftPath = connection && sourceBox && (targetBox
    ? edgeGeometry(sourceBox, targetBox).d
    : straightPath(borderPoint(sourceBox, connection.point), connection.point));

  return (
    <main
      ref={element} className={`board-canvas project-canvas${dragged ? ' is-dragging' : ''}${connection ? ' is-connecting' : ''}`}
      aria-label={folderName ? `${folderName}的项目画布` : '项目首页画布'}
      data-folder-id={folderId ?? ''} data-zoom={viewport.zoom}
      style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${26 * viewport.zoom}px ${26 * viewport.zoom}px` }}
      onPointerDown={begin} onPointerMove={track} onPointerUp={event => end(event)}
      onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}
      onKeyDown={event => {
        if (event.key === 'Escape' && gesture.current?.from) {
          const { pointer } = gesture.current;
          gesture.current = undefined;
          if (event.currentTarget.hasPointerCapture(pointer)) event.currentTarget.releasePointerCapture(pointer);
          setConnection(undefined);
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
          {laidRelations.map(({ key, relation, geometry: { d }, name }) => {
            return (
              <g key={key} className="project-relation" data-from={relation.from} data-to={relation.to}>
                <path className="project-relation-line" d={d} markerEnd={`url(#${marker})`} aria-hidden="true" />
                <path
                  className="project-relation-hit" d={d} role="button" tabIndex={disabled ? -1 : 0}
                  aria-label={name} aria-disabled={disabled}
                  onClick={event => {
                    if (!disabled) { event.stopPropagation(); setEditingName(key); }
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
                ><title>{name}</title></path>
              </g>
            );
          })}
          {draftPath && <path className="project-relation-line project-relation-draft" d={draftPath} markerEnd={`url(#${marker})`} aria-hidden="true" />}
        </svg>
        {tiles.map(tile => {
          const moving = dragged?.id === tile.row.id && dragged.kind === tile.kind;
          const point = tilePosition(tile);
          const folder = tile.kind === 'project';
          const cover = coverPreset(tile.coverId);
          return (
            <div
              key={`${tile.kind}:${tile.row.id}`}
              className={`project-tile is-${tile.kind}${moving ? ' is-moving' : ''}${dragged?.target === tile.row.id && folder ? ' is-drop-project' : ''}${connection?.target === tile.row.id && folder ? ' is-connection-target' : ''}${tile.favorite ? ' is-favorite' : ''}`}
              style={{ left: point.x, top: point.y, width: TILE_WIDTH, minHeight: TILE_HEIGHT }}
              data-project-folder={folder ? tile.row.id : undefined}
              onContextMenu={event => { if (!disabled) onMenu(event, tile); }}
            >
              <button
                type="button" disabled={disabled} className="project-tile-open"
                data-kind={tile.kind} data-id={tile.row.id}
                aria-label={tile.row.name} title={tile.row.name}
                onClick={event => { if (!suppressClick.current || event.detail === 0) onOpen(tile); }}
                onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) event.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true })); }}
              >
                <span className="project-tile-visual" aria-hidden="true" data-drop-project={folder ? tile.row.id : undefined}>
                  <ProjectTileArtwork kind={tile.kind} cover={cover} />
                </span>
                <span className="project-tile-title">{tile.row.name}</span>
                <TagDots tags={tags.filter(tag => tile.tagIds.includes(tag.id))} />
              </button>
              {folder && <button
                type="button" disabled={disabled} className="project-connect-port" data-connect-project={tile.row.id}
                aria-label={`从${tile.row.name}拉出项目连线`} title="拖到同层的项目建立连线"
                onClick={event => { if (event.detail === 0) onMenu(event, tile); }}
              ><span aria-hidden="true" /></button>}
              <button
                type="button" disabled={disabled} className="project-tile-star" aria-pressed={tile.favorite}
                aria-label={`收藏置顶${folder ? '项目' : '白板'}：${tile.row.name}`}
                title={tile.favorite ? '取消收藏' : '收藏并置顶'} onClick={() => onFavorite(tile)}
              ><Star size={15} fill={tile.favorite ? 'currentColor' : 'none'} /></button>
            </div>
          );
        })}
      </div>
      <div className="edge-label-layer project-relation-names">
        {laidRelations.map(({ key, relation, geometry }) => {
          if (!relation.label || key === editingName) return null;
          const { x, y } = worldToScreen(viewport, geometry.mid);
          const edit = () => { if (!disabled) setEditingName(key); };
          return <div key={key} onContextMenu={event => { if (!disabled) onRelationMenu(event, relation); }}>
            <EdgeLabel label={relation.label} x={x} y={y} zoom={viewport.zoom} onSelect={edit} onEdit={edit} />
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
        <button className="project-canvas-add" type="button" title={folderId ? '新建' : '新建项目'} aria-label={folderId ? '新建' : '新建项目'} aria-haspopup={folderId ? 'menu' : undefined} disabled={disabled} onClick={onAdd}>
          <Plus size={24} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}
