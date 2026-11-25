import type { Viewport } from '../api';
import { worldToScreen, type Vec2 } from '../canvas/CanvasEngine';
import { TILE_HEIGHT, TILE_WIDTH } from './layout';

const ZERO = { x: 0, y: 0 };
const GAP = 24;
export const translate = (p: Vec2, offset: Vec2): Vec2 => ({ x: p.x + offset.x, y: p.y + offset.y });

/** Leave room for the whole card, including its title and tags. */
export function radialPositions(center: Vec2, count: number): Vec2[] {
  const positions: Vec2[] = [];
  for (let ring = 1; positions.length < count; ring++) {
    const slots = Math.min(count - positions.length, ring * 6);
    const radius = ring === 1 && slots < 4 ? 1.18 : ring * 1.46;
    const sweep = ring === 1 && slots < 4 ? (slots - 1) * Math.PI / 3 : (slots - 1) * 2 * Math.PI / slots;
    const start = ring === 1 && slots < 4 ? -sweep / 2 : -Math.PI / 2;
    for (let i = 0; i < slots; i++) {
      const angle = start + i * sweep / Math.max(1, slots - 1);
      positions.push({
        x: center.x + Math.cos(angle) * radius * (TILE_WIDTH + GAP),
        y: center.y + Math.sin(angle) * radius * (TILE_HEIGHT + GAP),
      });
    }
  }
  return positions;
}

/** Prefer the space beyond the parent, keeping the cards already on screen in place. */
export function nestedPositions(center: Vec2, parent: Vec2, count: number, occupied: Vec2[]): Vec2[] {
  const width = TILE_WIDTH + GAP, height = TILE_HEIGHT + GAP;
  const cells = new Map<string, Vec2[]>();
  const occupy = (point: Vec2) => {
    const key = `${Math.floor(point.x / width)},${Math.floor(point.y / height)}`;
    const cell = cells.get(key);
    if (cell) cell.push(point);
    else cells.set(key, [point]);
  };
  for (const point of occupied) occupy(point);

  const outward = Math.atan2((center.y - parent.y) / height, (center.x - parent.x) / width);
  const positions: Vec2[] = [];
  for (let ring = 1; positions.length < count; ring++) {
    const slots = ring * 6;
    for (let slot = 0; slot < slots && positions.length < count; slot++) {
      // Alternate sides of the outward direction.
      const offset = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1);
      const angle = outward + offset * 2 * Math.PI / slots;
      const point = {
        x: center.x + Math.cos(angle) * width * ring * 1.46,
        y: center.y + Math.sin(angle) * height * ring * 1.46,
      };
      const column = Math.floor(point.x / width), row = Math.floor(point.y / height);
      let blocked = false;
      for (let x = column - 1; x <= column + 1 && !blocked; x++) {
        for (let y = row - 1; y <= row + 1 && !blocked; y++) {
          blocked = cells.get(`${x},${y}`)?.some(card => Math.abs(card.x - point.x) < width && Math.abs(card.y - point.y) < height) ?? false;
        }
      }
      if (blocked) continue;
      positions.push(point);
      occupy(point);
    }
  }
  return positions;
}

export function cardBounds(points: Vec2[]) {
  if (!points.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x + TILE_WIDTH);
    bottom = Math.max(bottom, p.y + TILE_HEIGHT);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const PUSH_DIRECTIONS = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
  ...[1, -1].flatMap(x => [1, -1].map(y => ({ x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 }))),
];

function axisOverlap(delta: number, direction: number, span: number): [number, number] {
  if (!direction) return Math.abs(delta) < span ? [-Infinity, Infinity] : [Infinity, -Infinity];
  const a = (delta - span) / direction, b = (delta + span) / direction;
  return [Math.min(a, b), Math.max(a, b)];
}

/** Move the other tiles as one group. Each interval is a collision along a candidate direction. */
export function peerOffset(peers: Vec2[], children: Vec2[], center: Vec2, score: (offset: Vec2) => number): Vec2 {
  const collides = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < TILE_WIDTH + GAP && Math.abs(a.y - b.y) < TILE_HEIGHT + GAP;
  if (!peers.some(peer => children.some(child => collides(peer, child)))) return ZERO;
  const obstacles = [...children, center];
  let best = ZERO, cost = Infinity;
  for (const dir of PUSH_DIRECTIONS) {
    const intervals: [number, number][] = [];
    for (const peer of peers) {
      for (const child of obstacles) {
        const [x1, x2] = axisOverlap(child.x - peer.x, dir.x, TILE_WIDTH + GAP);
        const [y1, y2] = axisOverlap(child.y - peer.y, dir.y, TILE_HEIGHT + GAP);
        const start = Math.max(0, x1, y1), end = Math.min(x2, y2);
        if (start < end) intervals.push([start, end]);
      }
    }
    intervals.sort(([a], [b]) => a - b);
    let distance = 0;
    for (const [start, end] of intervals) {
      if (start > distance) break;
      distance = Math.max(distance, end);
    }
    const offset = { x: dir.x * distance, y: dir.y * distance };
    const nextCost = distance + score(offset);
    if (nextCost < cost) {
      best = offset;
      cost = nextCost;
    }
  }
  return best;
}

export function visiblePosition(p: Vec2, view: Viewport, width: number, height: number) {
  const { x, y } = worldToScreen(view, p);
  return x < width && y < height && x + TILE_WIDTH * view.zoom > 0 && y + TILE_HEIGHT * view.zoom > 0;
}

/** Pan just enough to disclose the preview at the existing zoom. */
export function revealCards(base: Viewport, points: Vec2[], center: Vec2, width: number, height: number, priority?: Vec2[]): Viewport {
  const extent = cardBounds(points);
  if (!extent) return base;
  const padding = 24;
  const fits = extent.width * base.zoom + padding * 2 <= width && extent.height * base.zoom + padding * 2 <= height;
  const box = priority && !fits ? cardBounds(priority) ?? extent : extent;
  const pan = (origin: number, size: number, start: number, span: number, anchor: number, anchorSize: number) => {
    const first = padding - start * base.zoom;
    const last = size - padding - (start + span) * base.zoom;
    if (first <= last) return Math.min(last, Math.max(first, origin));
    // A large folder can extend beyond the viewport. Keep its entry card accessible.
    const low = padding - anchor * base.zoom, high = size - padding - (anchor + anchorSize) * base.zoom;
    return Math.min(Math.max(low, high), Math.max(low, Math.min(first, Math.max(last, origin))));
  };
  return {
    zoom: base.zoom,
    x: pan(base.x, width, box.x, box.width, center.x, TILE_WIDTH),
    y: pan(base.y, height, box.y, box.height, center.y, TILE_HEIGHT),
  };
}
