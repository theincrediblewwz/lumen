/**
 * 连线几何（M3）——纯函数，可在 Node 侧直接单测（DESIGN §8）。
 *
 * 全部在同一个 2D 平面内计算（本项目传入的是「屏幕坐标系」下的矩形），
 * 因此与视口缩放无关：EdgeLayer 每帧用 CanvasEngine 把节点世界矩形换算成
 * 屏幕矩形后调用这里，连线便自然跟随平移/缩放。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 以左上角为基准的矩形 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxCenter(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Find the card border along a ray starting inside it. */
export function borderPoint(box: Box, target: Pt, origin = boxCenter(box)): Pt {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  if (!dx && !dy) return { x: origin.x, y: box.y };
  const x = dx > 0 ? box.x + box.w : box.x;
  const y = dy > 0 ? box.y + box.h : box.y;
  const t = Math.min(dx ? (x - origin.x) / dx : Infinity, dy ? (y - origin.y) / dy : Infinity);
  return { x: origin.x + dx * t, y: origin.y + dy * t };
}

export interface EdgeGeometry {
  /** SVG path 的 d 属性 */
  d: string;
  /** 起点（吸附在源节点边框） */
  start: Pt;
  /** 终点（吸附在目标节点边框） */
  end: Pt;
  /** 路径中点，用于放标签 */
  mid: Pt;
}

/** Parallel spacing keeps opposing arrows individually reachable. */
export function edgeGeometry(a: Box, b: Box, separation = 0, port = borderPoint): EdgeGeometry {
  const ca = boxCenter(a), cb = boxCenter(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  const length = Math.hypot(dx, dy) || 1;
  const shift = Math.sign(separation) * Math.min(Math.abs(separation), Math.min(a.w, a.h, b.w, b.h) / 4);
  const from = { x: ca.x - dy / length * shift, y: ca.y + dx / length * shift };
  const to = { x: cb.x - dy / length * shift, y: cb.y + dx / length * shift };
  const start = port(a, to, from), end = port(b, from, to);
  return {
    d: straightPath(start, end), start, end,
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
  };
}

/** 直线路径（拖拽创建连线时的临时预览） */
export function straightPath(from: Pt, to: Pt): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/** 点是否落在矩形内（拖拽释放时的落点命中测试） */
export function boxContains(b: Box, p: Pt): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

/** Rounded, freely positioned elbow; endpoints always approach the correct card side. */
export function bentGeometry(a:Box,b:Box,control:Pt,scale=1,port=borderPoint):EdgeGeometry {
  const start=port(a,control),end=port(b,control),r=Math.min(10*scale,Math.hypot(control.x-start.x,control.y-start.y)/3,Math.hypot(end.x-control.x,end.y-control.y)/3);
  const beforeLength=Math.hypot(control.x-start.x,control.y-start.y)||1,afterLength=Math.hypot(end.x-control.x,end.y-control.y)||1;
  const before={x:control.x+(start.x-control.x)*r/beforeLength,y:control.y+(start.y-control.y)*r/beforeLength},after={x:control.x+(end.x-control.x)*r/afterLength,y:control.y+(end.y-control.y)*r/afterLength};
  return {start,end,mid:control,d:`M ${start.x} ${start.y} L ${before.x} ${before.y} Q ${control.x} ${control.y} ${after.x} ${after.y} L ${end.x} ${end.y}`};
}
export function distanceToSegment(p:Pt,a:Pt,b:Pt):number {
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length)):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}

export function nearStraightLine(a: Box, b: Box, point: Pt, zoom: number): boolean {
  const { start, end } = edgeGeometry(a, b);
  return distanceToSegment(point, start, end) * zoom < 18;
}
export function segmentHitsBox(a:Pt,b:Pt,box:Box,margin=0):boolean {
  let low=0,high=1;const dx=b.x-a.x,dy=b.y-a.y;
  for(const [p,q]of [[-dx,a.x-box.x+margin],[dx,box.x+box.w+margin-a.x],[-dy,a.y-box.y+margin],[dy,box.y+box.h+margin-a.y]]){
    if(p===0){if(q<0)return false;continue;}const r=q/p;if(p<0)low=Math.max(low,r);else high=Math.min(high,r);if(low>high)return false;
  }return true;
}
