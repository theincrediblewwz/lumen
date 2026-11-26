import type { BoardNode } from '../api';
import type { Box } from './geometry';

export const MIN_BOARD_ZOOM = 0.001;
export const DETAIL_ZOOM = 0.35;
export const FONT_FAMILIES = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: '"Songti SC", "STSong", Georgia, serif',
  sans: '"PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"SFMono-Regular", Menlo, monospace',
} as const;
export type BoardAppearance = { fontFamily: keyof typeof FONT_FAMILIES; fontSize: number; previewFontFamily?: keyof typeof FONT_FAMILIES; previewFontSize?: number; zoomSensitivity?: number };
export function boardAppearance(value?: Partial<BoardAppearance>): Required<BoardAppearance> {
  return { fontFamily: value?.fontFamily && value.fontFamily in FONT_FAMILIES ? value.fontFamily : 'system',
    fontSize: Number.isFinite(value?.fontSize) ? Math.min(32, Math.max(12, Number(value!.fontSize))) : 15,
    previewFontFamily: value?.previewFontFamily && Object.prototype.hasOwnProperty.call(FONT_FAMILIES,value.previewFontFamily) ? value.previewFontFamily : (value?.fontFamily && Object.prototype.hasOwnProperty.call(FONT_FAMILIES,value.fontFamily) ? value.fontFamily : 'system'),
    previewFontSize: Number.isFinite(value?.previewFontSize) ? Math.min(32,Math.max(12,Number(value!.previewFontSize))) : (Number.isFinite(value?.fontSize)?Math.min(32,Math.max(12,Number(value!.fontSize))):15),
    zoomSensitivity: Number.isFinite(value?.zoomSensitivity) ? Math.min(3,Math.max(0.25,Number(value!.zoomSensitivity))) : 1 };
}
export function heatLevel(zoom: number): number {
  return zoom >= DETAIL_ZOOM ? 0 : Math.max(1, Math.ceil(Math.log2(DETAIL_ZOOM / Math.max(MIN_BOARD_ZOOM, zoom))));
}
export const HEAT_LABEL_NAME_LIMIT = 60;
export const HEAT_LABEL_SIZE = { min: 12, max: 32, default: 17 };
export const DEFAULT_HEAT_LABEL_COLOR = '#00ab70';

export type HeatLabel = { name: string; color: string; fontSize: number };

export function readHeatLabel(value: unknown): HeatLabel | undefined {
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string') return;
  const name = Array.from(value.name.trim()).slice(0, HEAT_LABEL_NAME_LIMIT).join('');
  if (!name) return;
  const color = 'color' in value && typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color)
    ? value.color.toLowerCase() : DEFAULT_HEAT_LABEL_COLOR;
  const fontSize = 'fontSize' in value && typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)
    ? Math.round(Math.min(HEAT_LABEL_SIZE.max, Math.max(HEAT_LABEL_SIZE.min, value.fontSize))) : HEAT_LABEL_SIZE.default;
  return { name, color, fontSize };
}

export type HeatMarker = HeatLabel & { nodeId: string; x: number; y: number };
export type HeatCell = Box & {
  id: string; count: number; color: string | null; flowCount: number; flowColor: string | null;
  nodeIds: string[]; labels: HeatMarker[];
};
type HeatSizes = Readonly<Record<string, { w: number; h: number }>>;

export function heatNodeBox(node: BoardNode, sizes: HeatSizes = {}): Box {
  return { x: node.x, y: node.y, w: sizes[node.id]?.w ?? (node.w || 240), h: sizes[node.id]?.h ?? node.h ?? 96 };
}

/** A graph-anchored grid stays stable while panning; each coarser level merges four cells. */
export function aggregateHeat(nodes: readonly BoardNode[], level: number, sizes: HeatSizes = {}): HeatCell[] {
  const cellSize = 256 * 2 ** level, cells = new Map<string, HeatCell>();
  let originX = Infinity, originY = Infinity;
  for (const node of nodes) {
    const box = heatNodeBox(node, sizes);
    originX = Math.min(originX, box.x + box.w / 2);
    originY = Math.min(originY, box.y + box.h / 2);
  }
  originX = Math.floor(originX / 256) * 256;
  originY = Math.floor(originY / 256) * 256;
  for (const node of nodes) {
    const box = heatNodeBox(node, sizes);
    const x = box.x + box.w / 2, y = box.y + box.h / 2;
    const id = `${Math.floor((x - originX) / cellSize)},${Math.floor((y - originY) / cellSize)}`;
    const label = readHeatLabel(node.heatLabel);
    const color = node.color ?? null;
    const cell = cells.get(id);
    if (!cell) {
      cells.set(id, { ...box, id, count: 1, color, flowCount: node.flow ? 1 : 0,
        flowColor: node.flow ? color : null, nodeIds: [node.id], labels: label ? [{ ...label, nodeId: node.id, x, y }] : [] });
      continue;
    }
    const right = Math.max(cell.x + cell.w, box.x + box.w), bottom = Math.max(cell.y + cell.h, box.y + box.h);
    cell.x = Math.min(cell.x, box.x);
    cell.y = Math.min(cell.y, box.y);
    cell.w = right - cell.x;
    cell.h = bottom - cell.y;
    cell.count++;
    cell.nodeIds.push(node.id);
    if (label) cell.labels.push({ ...label, nodeId: node.id, x, y });
    if (node.flow) {
      cell.flowCount++;
      cell.flowColor ??= color;
    }
  }
  return [...cells.values()];
}

/** Stop at the first closer heat tier where this name appears on its own. */
export function isolatedHeatLabelZoom(nodes: readonly BoardNode[], nodeId: string, zoom: number, sizes: HeatSizes = {}): number | undefined {
  for (let level = heatLevel(zoom) - 1; level > 0; level--) {
    const cell = aggregateHeat(nodes, level, sizes).find(cell => cell.labels.some(label => label.nodeId === nodeId));
    if (cell?.labels.length === 1) return DETAIL_ZOOM * 2 ** (1 - level) * 0.92;
  }
}
export function intersects(a: Box, b: Box, margin = 0): boolean {
  return a.x+a.w >= b.x-margin && a.x <= b.x+b.w+margin && a.y+a.h >= b.y-margin && a.y <= b.y+b.h+margin;
}
export function snapConnection(point: {x:number;y:number}, nodes: BoardNode[], fromId: string,
  boxOf: (n:BoardNode)=>Box, zoom:number, tolerance = 26): string | null {
  let best: string | null = null, bestDistance=Infinity, bestCenter=Infinity;
  for (const n of nodes) {
    if (n.id===fromId) continue;
    const b=boxOf(n), dx=Math.max(b.x-point.x,0,point.x-b.x-b.w),dy=Math.max(b.y-point.y,0,point.y-b.y-b.h);
    const distance=Math.hypot(dx,dy)*zoom, center=Math.hypot(point.x-b.x-b.w/2, point.y-b.y-b.h/2);
    if(distance<=tolerance && (distance<bestDistance || distance===bestDistance&&center<bestCenter)) {
      best=n.id;bestDistance=distance;bestCenter=center;
    }
  }
  return best;
}
export function resizedBox(box: Box, corner:string, dx:number,dy:number): Box {
  const w=Math.min(2400,Math.max(120,box.w+(corner.includes('w')?-dx:dx)));
  const h=Math.min(4000,Math.max(64,box.h+(corner.includes('n')?-dy:dy)));
  return {x:corner.includes('w')?box.x+box.w-w:box.x,y:corner.includes('n')?box.y+box.h-h:box.y,w,h};
}
export function imageDisplaySize(width:number,height:number):{w:number;h:number}{
  const longest=Math.max(width,height),scale=Math.min(600,Math.max(160,longest))/longest;
  return {w:width*scale,h:height*scale};
}
export function resizedImageBox(box:Box,corner:string,dx:number,dy:number):Box{
  const sx=(box.w+(corner.includes('w')?-dx:dx))/box.w,sy=(box.h+(corner.includes('n')?-dy:dy))/box.h;
  const longest=Math.max(box.w,box.h),scale=Math.min(2400/longest,Math.max(64/longest,Math.abs(sx-1)>=Math.abs(sy-1)?sx:sy));
  const w=box.w*scale,h=box.h*scale;
  return {x:corner.includes('w')?box.x+box.w-w:box.x,y:corner.includes('n')?box.y+box.h-h:box.y,w,h};
}
export const questionPath = (id: string) => `docs/question_${id}.md`;
export const isQuestionDoc = (path: string) => /^docs\/question_[a-zA-Z0-9_-]+\.md$/.test(path);
