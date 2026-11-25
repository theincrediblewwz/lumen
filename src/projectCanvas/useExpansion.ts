import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { BoardMeta, Viewport } from '../api';
import type { Vec2 } from '../canvas/CanvasEngine';
import { cardBounds, nestedPositions, peerOffset, radialPositions, revealCards, translate, visiblePosition } from './expansion';
import { readProjectView, saveProjectView, type CatalogTile } from './layout';

const ZERO = { x: 0, y: 0 };
const interpolate = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: interpolate(a.x, b.x, t), y: interpolate(a.y, b.y, t) });
const ease = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));
export const tileKey = (tile: CatalogTile) => `${tile.kind}:${tile.row.id}`;

type FolderRequest = { id: string; state: 'loading' | 'error' } | { id: string; state: 'ready'; boards: BoardMeta[] };
type PreviewLevel = { folder: CatalogTile; request: FolderRequest; children: CatalogTile[] };
type Branch = { owner: string; root: string; tile: CatalogTile; point: Vec2; origin: Vec2; opacity: number; retiring?: boolean };
type Scene = { offsets: Map<string, Vec2>; branches: Branch[] };
const EMPTY_SCENE: Scene = { offsets: new Map(), branches: [] };
const branchKey = (branch: Branch) => `${branch.owner}:${tileKey(branch.tile)}`;

function arrangePreviews(tiles: CatalogTile[], levels: PreviewLevel[], base: Viewport, width: number, height: number) {
  const scene: Scene = { offsets: new Map(), branches: [] };
  const first = levels[0];
  if (!first?.children.length) return { scene, viewport: base };

  const { folder: root } = first;
  const center = root.position;
  const positions = radialPositions(center, first.children.length);
  const peers = tiles.filter(tile => tile !== root);
  const visible = peers.filter(tile => visiblePosition(tile.position, base, width, height));
  const boundsWith = (offset: Vec2) => [center, ...positions, ...visible.map(tile => translate(tile.position, offset))];
  const shift = peerOffset(peers.map(tile => tile.position), positions, center, offset => {
    const box = cardBounds(boundsWith(offset))!;
    return Math.max(0, box.width - width / base.zoom) + Math.max(0, box.height - height / base.zoom);
  });
  for (const tile of peers) scene.offsets.set(tileKey(tile), shift);
  const occupied = [center, ...peers.map(tile => translate(tile.position, shift))];
  const visiblePoints = boundsWith(shift);
  let viewport = revealCards(base, visiblePoints, center, width, height);
  const folders = new Map([[root.row.id, center]]);

  for (const [depth, level] of levels.entries()) {
    if (!level.children.length) break;
    const owner = level.folder.row.id;
    const origin = folders.get(owner)!;
    const points = depth === 0 ? positions : nestedPositions(
      origin, folders.get(levels[depth - 1].folder.row.id)!, level.children.length, occupied,
    );
    for (const [i, tile] of level.children.entries()) {
      const point = points[i];
      if (tile.kind === 'project') folders.set(tile.row.id, point);
      occupied.push(point);
      if (depth > 0) visiblePoints.push(point);
      scene.branches.push({ owner, root: root.row.id, tile, point, origin, opacity: 1 });
    }
    if (depth > 0) {
      viewport = revealCards(viewport, visiblePoints, origin, width, height, [origin, ...points]);
    }
  }
  return { scene, viewport };
}

function folderPositions(tiles: CatalogTile[], scene: Scene) {
  const folders = new Map<string, Vec2>();
  for (const tile of tiles) {
    if (tile.kind === 'project') folders.set(tile.row.id, translate(tile.position, scene.offsets.get(tileKey(tile)) ?? ZERO));
  }
  for (const branch of scene.branches) {
    if (branch.tile.kind === 'project') folders.set(branch.tile.row.id, branch.point);
  }
  return folders;
}

export function useExpansion({ host, scope, folderId, tiles, readBoards, previewTiles }: {
  host: RefObject<HTMLElement>;
  scope: string;
  folderId: string | null;
  tiles: CatalogTile[];
  readBoards: (id: string) => Promise<BoardMeta[]>;
  previewTiles: (id: string, boards: BoardMeta[]) => CatalogTile[];
}) {
  const [viewport, setViewport] = useState(() => readProjectView(scope, folderId));
  const view = useRef(viewport);
  const savedView = useRef(viewport);
  const cameraInput = useRef(0);
  const transient = useRef(false);
  const [requests, setRequests] = useState<FolderRequest[]>([]);
  const [scene, setScene] = useState(EMPTY_SCENE);
  const currentScene = useRef(scene);
  const levels = useMemo(() => {
    const valid: PreviewLevel[] = [];
    let candidates = tiles;
    for (const request of requests) {
      const folder = candidates.find(tile => tile.kind === 'project' && tile.row.id === request.id);
      if (!folder) break;
      const children = request.state === 'ready' ? previewTiles(request.id, request.boards) : [];
      valid.push({ folder, request, children });
      candidates = children;
    }
    return valid;
  }, [requests, tiles, previewTiles]);
  const expanded = useMemo(() => new Map(levels.map(({ request, children }) => [request.id,
    request.state === 'loading' ? '正在读取…'
      : request.state === 'error' ? '预览读取失败，收起后可重试' : children.length ? undefined : '',
  ])), [levels]);
  const pending = levels[levels.length - 1]?.request;

  function publishView(next: Viewport) {
    view.current = next;
    setViewport(next);
  }

  function takeCamera() { cameraInput.current++; }
  function setView(next: Viewport) {
    takeCamera();
    publishView(next);
    if (!transient.current) savedView.current = next;
  }
  const persistView = useCallback(() => saveProjectView(scope, folderId, savedView.current), [scope, folderId]);

  function close() {
    setRequests([]);
  }

  function toggle(id: string, owner?: string) {
    const depth = owner === undefined ? 0 : levels.findIndex(level => level.request.id === owner) + 1;
    if (owner !== undefined && depth === 0) return;
    transient.current = true;
    setRequests(current => {
      const prefix = current.slice(0, depth);
      return current[depth]?.id === id ? prefix : [...prefix, { id, state: 'loading' }];
    });
  }

  useEffect(() => () => persistView(), [persistView]);
  useEffect(() => {
    if (levels.length < requests.length) {
      setRequests(current => current === requests ? current.slice(0, levels.length) : current);
    }
  }, [requests, levels.length]);
  useEffect(() => {
    if (pending?.state !== 'loading') return;
    let current = true;
    function finish(request: FolderRequest) {
      if (current) setRequests(path => path[path.length - 1] === pending ? [...path.slice(0, -1), request] : path);
    }
    void readBoards(pending.id).then(
      boards => finish({ id: pending.id, state: 'ready', boards }),
      () => finish({ id: pending.id, state: 'error' }),
    );
    return () => { current = false; };
  }, [pending, readBoards]);

  useLayoutEffect(() => {
    const canvas = host.current;
    if (!canvas || pending?.state === 'loading' || !transient.current) return;
    const from = currentScene.current;
    const base = savedView.current;
    const fromView = view.current;
    const camera = cameraInput.current;
    const { scene: target, viewport: toView } = arrangePreviews(tiles, levels, base, canvas.clientWidth, canvas.clientHeight);
    const fromFolders = folderPositions(tiles, from);
    const toFolders = folderPositions(tiles, target);
    // A collapsing folder and its descendants retract together to the nearest surviving parent.
    for (const branch of from.branches) {
      if (branch.tile.kind === 'project' && !toFolders.has(branch.tile.row.id)) {
        toFolders.set(branch.tile.row.id, toFolders.get(branch.owner) ?? branch.origin);
      }
    }

    const starts = new Map(from.branches.map(branch => [branchKey(branch), branch]));
    const ends = new Map(target.branches.map(branch => [branchKey(branch), branch]));
    const trajectories = [...new Set([...starts.keys(), ...ends.keys()])].map(key => {
      const start = starts.get(key), end = ends.get(key);
      if (end) return { start: start ?? { ...end, point: fromFolders.get(end.owner) ?? end.origin, opacity: 0 }, end };
      const last = start!;
      const origin = toFolders.get(last.owner) ?? last.origin;
      return { start: last, end: { ...last, point: origin, origin, opacity: 0, retiring: true } };
    });
    const offsets = [...new Set([...from.offsets.keys(), ...target.offsets.keys()])];
    const setFrame = (progress: number, cameraProgress: number) => {
      const next: Scene = progress === 1 ? target : {
        offsets: new Map(offsets.map(id => [id, between(from.offsets.get(id) ?? ZERO, target.offsets.get(id) ?? ZERO, progress)])),
        branches: trajectories.map(({ start, end }) => ({
          ...end, point: between(start.point, end.point, progress), opacity: interpolate(start.opacity, end.opacity, progress),
        })),
      };
      currentScene.current = next;
      setScene(next);
      if (camera === cameraInput.current) {
        publishView({ ...between(fromView, toView, cameraProgress), zoom: interpolate(fromView.zoom, toView.zoom, cameraProgress) });
      }
      if (progress === 1 && !levels.length) {
        transient.current = false;
        if (camera !== cameraInput.current) savedView.current = view.current;
      }
    };
    if ((!trajectories.length && !offsets.length)
      || document.documentElement.classList.contains('motion-off')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFrame(1, 1);
      return;
    }
    const start = performance.now();
    const duration = trajectories.some(({ start, end }) => end.opacity > start.opacity) ? 460 : 350;
    // Keep the clicked folder under the pointer while a double click can still follow.
    const panDelay = 170;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      // Use one clock for card positions, connecting lines, and the camera.
      setFrame(ease(t), ease(Math.min(1, Math.max(0, (now - start - panDelay) / (duration - panDelay)))));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [host, levels, pending, tiles]);

  return { viewport, view, setView, takeCamera, persistView, expanded, scene, toggle, close };
}
