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
export type HeatCell = { id: string; count: number; x: number; y: number; w: number; h: number; color: string | null };
/** A graph-anchored grid stays stable while panning; each coarser level merges four cells. */
export function aggregateHeat(nodes: BoardNode[], level: number, sizes: Record<string, {w:number;h:number}> = {}): HeatCell[] {
  const cellSize = 256 * 2 ** level, cells = new Map<string, HeatCell>();
  let originX=Infinity,originY=Infinity;
  for(const n of nodes){originX=Math.min(originX,n.x+(n.w||240)/2);originY=Math.min(originY,n.y+(n.h??sizes[n.id]?.h??96)/2);}
  originX=Math.floor(originX/256)*256;originY=Math.floor(originY/256)*256;
  for (const n of nodes) {
    const w = n.w || 240, h = n.h ?? sizes[n.id]?.h ?? 96;
    const id = `${Math.floor((n.x + w / 2 - originX) / cellSize)},${Math.floor((n.y + h / 2 - originY) / cellSize)}`;
    const cell = cells.get(id);
    if (!cell) cells.set(id, {id, count:1, x:n.x, y:n.y, w, h, color:n.color ?? null});
    else { const right = Math.max(cell.x + cell.w, n.x + w), bottom = Math.max(cell.y + cell.h, n.y + h);
      cell.x = Math.min(cell.x, n.x); cell.y = Math.min(cell.y, n.y); cell.w = right-cell.x; cell.h=bottom-cell.y; cell.count++; }
  }
  return [...cells.values()];
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
