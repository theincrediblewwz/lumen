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

/** 连线视觉样式：曲线（贝塞尔）/ 直线 / 折线（正交直角） */
export type EdgeStyle = 'curved' | 'straight' | 'stepped';

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
  /** SVG path 的 d 属性 */
  d: string;
  /** 起点（吸附在源节点边框） */
  start: Pt;
  /** 终点（吸附在目标节点边框） */
  end: Pt;
  /** 路径中点，用于放标签 */
  mid: Pt;
}

/**
 * 计算两个矩形之间的连线路径，按 style 决定形状：
 * - 端点始终吸附到各自边框（朝对方中心方向）
 * - curved：三次贝塞尔，控制柄沿离开各自节点的方向伸出，得到自然弧线
 * - straight：两吸附点之间直线
 * - stepped：正交折线（沿主导轴走一半再拐直角），中点取拐点
 */
export function edgeGeometry(a: Box, b: Box, style: EdgeStyle = 'curved'): EdgeGeometry {
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  const start = borderPoint(a, cb);
  const end = borderPoint(b, ca);

  if (style === 'straight') {
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return { d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, start, end, mid };
  }

  if (style === 'stepped') {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // 主导轴：水平差更大则先水平走到中点 x，再竖直，再水平（H-V-H）；否则竖直优先
    let waypoints: Pt[];
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = start.x + dx / 2;
      waypoints = [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
    } else {
      const my = start.y + dy / 2;
      waypoints = [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
    }
    const d =
      `M ${waypoints[0].x} ${waypoints[0].y} ` +
      waypoints.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');
    return { d, start, end, mid: waypoints[1] === undefined ? start : waypoints[Math.floor(waypoints.length / 2)] };
  }

  // curved（默认）：控制点沿弦 1/3、2/3 处并朝垂直方向弓出一段，
  // 保证无论节点如何摆放都有明显且一致的弧度（避免同高并排时退化成直线）。
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = len(dx, dy);
  // 弦方向单位向量与其垂直向量
  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy;
  const py = ux;
  // 弓高：随距离自适应，短线也有可见弧、长线不过分夸张
  const bow = Math.max(18, Math.min(dist * 0.22, 90));
  const c1: Pt = { x: start.x + ux * (dist / 3) + px * bow, y: start.y + uy * (dist / 3) + py * bow };
  const c2: Pt = { x: start.x + ux * (dist * 2 / 3) + px * bow, y: start.y + uy * (dist * 2 / 3) + py * bow };

  const mid = bezierMid(start, c1, c2, end);
  const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
  return { d, start, end, mid };
}

/** 直线路径（拖拽创建连线时的临时预览） */
export function straightPath(from: Pt, to: Pt): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/** 点是否落在矩形内（拖拽释放时的落点命中测试） */
export function boxContains(b: Box, p: Pt): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
