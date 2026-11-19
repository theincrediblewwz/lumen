import { bentGeometry, borderPoint, boxCenter, boxContains, edgeGeometry, nearStraightLine, type Box, type EdgeGeometry, type Pt } from '../canvas/geometry';
import type { ProjectRelation, RelationBend } from './layout';

const LIMIT = 16;
const clamp = (value: number) => Math.min(LIMIT, Math.max(-LIMIT, value));
export const relationKey = (relation: Pick<ProjectRelation, 'from' | 'to'>) => `${relation.from}:${relation.to}`;
export type ProjectBox = Box & { folder?: true };

// The extra part of the folder above its face only occupies the left side.
export function projectPort(box: ProjectBox, target: Pt, origin = boxCenter(box)): Pt {
  const face = borderPoint(box, target, origin);
  if (!box.folder || face.y > box.y + 0.01 || target.y >= box.y) return face;
  const tab = { x: box.x + 4, y: box.y - 11, w: 43, h: 11.02 };
  return boxContains(tab, face) ? borderPoint(tab, target, face) : face;
}

// The bend rotates and scales with the two cards, including when they are spread out in a folder preview.
export function bendAt(from: Box, to: Box, point: Pt, zoom: number): RelationBend | null {
  if (nearStraightLine(from, to, point, zoom)) return null;
  const a = boxCenter(from), b = boxCenter(to);
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  if (!squared) return null;
  const x = point.x - a.x, y = point.y - a.y;
  return { along: clamp((x * dx + y * dy) / squared), offset: clamp((y * dx - x * dy) / squared) };
}

export function relationGeometry(from: ProjectBox, to: ProjectBox, bend?: RelationBend | null, separation = 0): EdgeGeometry {
  if (!bend) return edgeGeometry(from, to, separation, projectPort);
  const a = boxCenter(from), b = boxCenter(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  return bentGeometry(from, to, {
    x: a.x + bend.along * dx - bend.offset * dy,
    y: a.y + bend.along * dy + bend.offset * dx,
  }, 1, projectPort);
}

export function spaceBetweenCards(from: Box, to: Box, { start, end }: EdgeGeometry) {
  const a = boxCenter(from), b = boxCenter(to);
  return (end.x - start.x) * (b.x - a.x) + (end.y - start.y) * (b.y - a.y) > 0;
}

export function relationLabelPoint({ mid }: EdgeGeometry, from: Box, to: Box, label?: string): Pt {
  if (!label) return mid;
  const halfWidth = Math.min(180, Array.from(label).length * 5.5 + 5);
  const overlaps = (box: Box) => mid.x + halfWidth > box.x && mid.x - halfWidth < box.x + box.w
    && mid.y + 12 > box.y && mid.y - 12 < box.y + box.h;
  if (!overlaps(from) && !overlaps(to)) return mid;
  const across = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  if (across) {
    return { x: mid.x, y: to.x >= from.x ? Math.min(from.y, to.y) - 20 : Math.max(from.y + from.h, to.y + to.h) + 24 };
  }
  return { x: to.y >= from.y ? Math.max(from.x + from.w, to.x + to.w) + halfWidth + 10
    : Math.min(from.x, to.x) - halfWidth - 10, y: mid.y };
}
