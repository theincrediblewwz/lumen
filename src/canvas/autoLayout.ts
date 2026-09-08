/**
 * 树状自动布局（M6-4）：只重排节点坐标，**不改任何结构**（节点/连线本身不变）。
 *
 * 思路（分层 tidy-tree，稳健处理森林 / 环 / 多父 / 孤立节点）：
 *  1) 由连线构建父子关系：有向边 from→to 视为父→子；无向边两向都可作为树边，
 *     以 BFS 首次访问确定归属，避免歧义。
 *  2) 根 = 没有入边的节点（森林可有多个根）；再补上环/孤立里未被访问到的节点作根。
 *  3) BFS 定层：根在第 0 层，子节点逐层加深 → 决定“行”（y）。
 *  4) x 用子树排布：叶子按顺序占位，父节点居中于其子节点之上 → 显著减少连线交叉。
 *  5) 层与层之间按各行最大节点高度留白；同层节点按宽度 + 间距排开，绝不重叠。
 *
 * 返回新的 {id -> {x,y}}，调用方据此更新节点位置（会进历史，可撤销）。
 */

export interface LayoutNode {
  id: string;
  w: number;
  /** 估算高度（节点是 DOM 自适应高度，这里给个名义值用于分层留白） */
  h?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  directed: boolean;
}

export interface LayoutOptions {
  /** 同层相邻节点的水平间距 */
  hGap?: number;
  /** 相邻层的垂直间距 */
  vGap?: number;
  /** 名义节点高度（无法测量 DOM 时的兜底） */
  nodeH?: number;
  /** 布局原点（通常是当前视图左上或原坐标包围盒左上） */
  originX?: number;
  originY?: number;
}

export interface Pos {
  x: number;
  y: number;
}

const DEFAULTS = {
  hGap: 48,
  vGap: 90,
  nodeH: 72,
  originX: 120,
  originY: 120,
};

/**
 * 计算树状布局。纯函数，无副作用。
 * @returns Map<id, {x,y}>，仅包含传入的节点。
 */
export function computeTreeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, Pos> {
  const opt = { ...DEFAULTS, ...options };
  const result = new Map<string, Pos>();
  if (nodes.length === 0) return result;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1) 邻接：children[parent] = [child...]；记录入度（仅统计能连到已知节点的边）
  const children = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    children.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  // 有向边优先建立父子；无向边先存起来，BFS 时按需使用
  const undirected: Array<[string, string]> = [];
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    if (e.directed) {
      children.get(e.from)!.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    } else {
      undirected.push([e.from, e.to]);
    }
  }

  // 无向邻接表（供 BFS 补充树边）
  const uAdj = new Map<string, string[]>();
  for (const n of nodes) uAdj.set(n.id, []);
  for (const [a, b] of undirected) {
    uAdj.get(a)!.push(b);
    uAdj.get(b)!.push(a);
  }

  // 2) 选根：入度为 0 的优先；保持输入顺序稳定
  const roots: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) roots.push(n.id);
  }
  // 若全是环导致无入度 0 节点，用第一个节点兜底
  if (roots.length === 0) roots.push(nodes[0].id);

  // 3) BFS 定层 + 补无向树边；visited 防环与多父重复
  const depth = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const visited = new Set<string>();
  const orderedChildren = new Map<string, string[]>(); // 实际用于布局的子树
  for (const n of nodes) orderedChildren.set(n.id, []);

  const queue: string[] = [];
  const bfsFrom = (id: string) => {
    // 已被前一棵树（含无向邻居）认领则不再单独成根
    if (visited.has(id)) return;
    visited.add(id);
    depth.set(id, 0);
    parent.set(id, null);
    queue.push(id);
    while (queue.length) {
      const cur = queue.shift()!;
      const d = depth.get(cur)!;
      // 先走有向子节点，再走无向邻居（首次访问才纳入树）
      const next = [...children.get(cur)!, ...uAdj.get(cur)!];
      for (const nxt of next) {
        if (visited.has(nxt)) continue;
        visited.add(nxt);
        depth.set(nxt, d + 1);
        parent.set(nxt, cur);
        orderedChildren.get(cur)!.push(nxt);
        queue.push(nxt);
      }
    }
  };

  // 先从有向根（入度 0）出发，无向邻居会在各自 BFS 中被认领，不会重复成根
  for (const r of roots) bfsFrom(r);
  // 补齐仍未访问的节点（纯环 / 独立子图 / 孤立点），按输入顺序各自成根
  for (const nd of nodes) bfsFrom(nd.id);

  // 4) x 用子树排布：后序遍历，叶子顺序占位，父节点居中于子节点
  //    先按层最大高度算各层 y。
  const maxDepth = Math.max(...Array.from(depth.values()));
  const layerH: number[] = new Array(maxDepth + 1).fill(0);
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const h = n.h ?? opt.nodeH;
    if (h > layerH[d]) layerH[d] = h;
  }
  const layerY: number[] = [];
  let accY = opt.originY;
  for (let d = 0; d <= maxDepth; d++) {
    layerY[d] = accY;
    accY += (layerH[d] || opt.nodeH) + opt.vGap;
  }

  // 后序分配 x：用一个游标记录当前叶子推进到的 x
  let cursorX = opt.originX;
  const xById = new Map<string, number>();

  // xById 统一存“节点中心 x”，避免叶子(左边缘)与父(中心)语义混用导致错位。
  const assignX = (id: string): number => {
    const kids = orderedChildren.get(id)!;
    const w = byId.get(id)!.w;
    if (kids.length === 0) {
      const center = cursorX + w / 2;
      xById.set(id, center);
      cursorX += w + opt.hGap;
      return center;
    }
    const childCenters = kids.map((k) => assignX(k));
    // 父节点居中于其子节点中心跨度之上
    const center = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
    xById.set(id, center);
    return center;
  };

  // 按根的发现顺序布局各棵树，森林横向依次排开（cursorX 天然递增）
  const rootsInOrder = nodes.filter((n) => parent.get(n.id) === null).map((n) => n.id);
  for (const r of rootsInOrder) assignX(r);

  // 5) 汇总坐标：xById 为中心，转成左上角坐标（与 BoardNode.x 语义一致：左上）
  for (const n of nodes) {
    const cx = xById.get(n.id) ?? opt.originX + n.w / 2;
    const d = depth.get(n.id) ?? 0;
    result.set(n.id, {
      x: Math.round(cx - n.w / 2),
      y: Math.round(layerY[d] ?? opt.originY),
    });
  }
  return result;
}
