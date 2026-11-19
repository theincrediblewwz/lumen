import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { BoardMeta, Viewport } from '../api';
import type { Vec2 } from '../canvas/CanvasEngine';
import { cardBounds, peerOffset, radialPositions, revealCards, translate, visiblePosition } from './expansion';
import { readProjectView, saveProjectView, type CatalogTile } from './layout';

const ZERO = { x: 0, y: 0 };
const interpolate = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: interpolate(a.x, b.x, t), y: interpolate(a.y, b.y, t) });
const ease = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));
export const tileKey = (tile: CatalogTile) => `${tile.kind}:${tile.row.id}`;

type Branch = { owner: string; tile: CatalogTile; point: Vec2; origin: Vec2; opacity: number };
type Scene = { offsets: Map<string, Vec2>; branches: Branch[] };
const EMPTY_SCENE: Scene = { offsets: new Map(), branches: [] };
const branchKey = (branch: Branch) => `${branch.owner}:${tileKey(branch.tile)}`;

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
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<{ owner: string; boards?: BoardMeta[] }>();
  const [scene, setScene] = useState(EMPTY_SCENE);
  const currentScene = useRef(scene);
  const anchor = tiles.find(tile => tile.kind === 'project' && tile.row.id === selected);
  const children = useMemo(() => selected && content?.owner === selected && content.boards
    ? previewTiles(selected, content.boards) : [], [selected, content, previewTiles]);

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
    setSelected(undefined);
    setContent(undefined);
  }

  function toggle(id: string) {
    if (selected === id) { close(); return; }
    transient.current = true;
    setContent(undefined);
    setSelected(id);
  }

  useEffect(() => () => persistView(), [persistView]);
  useEffect(() => {
    if (selected && !anchor) close();
  }, [selected, anchor]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    void readBoards(selected).then(
      boards => { if (current) setContent({ owner: selected, boards }); },
      () => { if (current) setContent({ owner: selected }); },
    );
    return () => { current = false; };
  }, [selected, readBoards]);

  useLayoutEffect(() => {
    const canvas = host.current;
    if (!canvas || (anchor && content?.owner !== selected) || !transient.current) return;
    const from = currentScene.current;
    const base = savedView.current;
    const fromView = view.current;
    const camera = cameraInput.current;
    const target: Scene = { offsets: new Map(), branches: [] };
    let toView = base;
    if (anchor && selected && children.length) {
      const center = anchor.position;
      const positions = radialPositions(center, children.length);
      const peers = tiles.filter(tile => tile !== anchor);
      const { clientWidth: width, clientHeight: height } = canvas;
      const visible = peers.filter(tile => visiblePosition(tile.position, base, width, height));
      const extent = [center, ...positions];
      const boundsWith = (offset: Vec2) => [...extent, ...visible.map(tile => translate(tile.position, offset))];
      const shift = peerOffset(peers.map(tile => tile.position), positions, center, offset => {
        const box = cardBounds(boundsWith(offset))!;
        return Math.max(0, box.width - width / base.zoom) + Math.max(0, box.height - height / base.zoom);
      });
      for (const tile of peers) target.offsets.set(tileKey(tile), shift);
      target.branches = children.map((tile, i) => ({ owner: selected, tile, point: positions[i], origin: center, opacity: 1 }));
      toView = revealCards(base, boundsWith(shift), center, width, height);
    }

    const starts = new Map(from.branches.map(branch => [branchKey(branch), branch]));
    const ends = new Map(target.branches.map(branch => [branchKey(branch), branch]));
    const trajectories = [...new Set([...starts.keys(), ...ends.keys()])].map(key => {
      const start = starts.get(key), end = ends.get(key);
      if (end) return { start: start ?? { ...end, point: end.origin, opacity: 0 }, end };
      const last = start!;
      const owner = tiles.find(tile => tile.kind === 'project' && tile.row.id === last.owner);
      const origin = owner ? translate(owner.position, target.offsets.get(tileKey(owner)) ?? ZERO) : last.origin;
      return { start: last, end: { ...last, point: origin, origin, opacity: 0 } };
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
      if (progress === 1 && !anchor) {
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
    const duration = anchor ? 460 : 350;
    // Give the open gesture time for a second click before the camera eases away.
    const panDelay = anchor ? 170 : 0;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      // Use one clock for card positions, connecting lines, and the camera.
      setFrame(ease(t), ease(Math.min(1, Math.max(0, (now - start - panDelay) / (duration - panDelay)))));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, children, content, host, selected, tiles]);

  const message = anchor && (content?.owner !== selected ? '正在读取…'
    : !content?.boards ? '预览读取失败，收起后可重试' : children.length ? undefined : '');
  return { viewport, view, setView, takeCamera, persistView, selected, scene, message, toggle, close };
}
