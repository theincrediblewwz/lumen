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

function len(x: number, y: number): number {
  return Math.hypot(x, y) || 1;
}

/**
 * 从矩形中心朝 target 方向，求射线与矩形边框的交点（端点吸附到边框而非中心）。
 * 用「按半宽/半高归一化取较大者」的经典方法，天然处理四条边。
 */
export function borderPoint(b: Box, target: Pt): Pt {
  const c = boxCenter(b);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: b.y }; // 退化：取上边中点
  const hw = b.w / 2;
  const hh = b.h / 2;
  // 需要的缩放 t，使 c + t*(dx,dy) 落在边框上
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** 三次贝塞尔在 t=0.5 处的点 */
function bezierMid(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  return {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  };
}

export interface EdgeGeometry {
  /** SVG path 的 d 属性（三次贝塞尔） */
  d: string;
  /** 起点（吸附在源节点边框） */
  start: Pt;
  /** 终点（吸附在目标节点边框） */
  end: Pt;
  /** 曲线中点，用于放标签 */
  mid: Pt;
}

/**
 * 计算两个矩形之间的平滑连线：
 * - 端点吸附到各自边框（朝对方中心方向）
 * - 控制柄沿「离开各自节点」的方向伸出，长度随距离自适应，得到自然的 S/弧线
 */
export function edgeGeometry(a: Box, b: Box): EdgeGeometry {
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  const start = borderPoint(a, cb);
  const end = borderPoint(b, ca);

  const dist = len(end.x - start.x, end.y - start.y);
  const handle = Math.max(28, Math.min(dist * 0.42, 170));

  // 离开源/目标节点的外法向（近似为「边框点相对中心」的方向）
  const oa = { x: start.x - ca.x, y: start.y - ca.y };
  const ob = { x: end.x - cb.x, y: end.y - cb.y };
  const la = len(oa.x, oa.y);
  const lb = len(ob.x, ob.y);
  const c1: Pt = { x: start.x + (oa.x / la) * handle, y: start.y + (oa.y / la) * handle };
  const c2: Pt = { x: end.x + (ob.x / lb) * handle, y: end.y + (ob.y / lb) * handle };

  const mid = bezierMid(start, c1, c2, end);
  const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
  return { d, start, end, mid };
}

/** 直线路径（拖拽创建连线时的临时预览，降级为直线避免每帧重算贝塞尔） */
export function straightPath(from: Pt, to: Pt): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/** 点是否落在矩形内（拖拽释放时的落点命中测试） */
export function boxContains(b: Box, p: Pt): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
