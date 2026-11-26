import type { BoardEdge, BoardNode } from '../api';

/** Follow question arrows only. Iterative traversal handles deep graphs and cycles. */
export function descendantIds(nodes:Pick<BoardNode,'id'>[],edges:Pick<BoardEdge,'from'|'to'|'directed'>[],root:string|readonly string[]):Set<string>{
  const valid=new Set(nodes.map(n=>n.id)),next=new Map<string,string[]>();
  const visited=new Set((typeof root==='string'?[root]:root).filter(id=>valid.has(id))),queue=[...visited];
  if(!queue.length)return visited;
  for(const e of edges)if(e.directed&&valid.has(e.from)&&valid.has(e.to)){const row=next.get(e.from)??[];row.push(e.to);next.set(e.from,row);}
  for(let index=0;index<queue.length;index++)for(const child of next.get(queue[index])??[])if(!visited.has(child)){visited.add(child);queue.push(child);}
  return visited;
}

export function translateFromBaseline(nodes:BoardNode[],baseline:ReadonlyMap<string,{x:number;y:number}>,dx:number,dy:number):BoardNode[]{
  if(!Number.isFinite(dx)||!Number.isFinite(dy))return nodes;
  return nodes.map(node=>{const start=baseline.get(node.id);return start?{...node,x:start.x+dx,y:start.y+dy}:node;});
}

export function translateBends(edges: BoardEdge[], nodes: BoardNode[], positions: ReadonlyMap<string, {x: number; y: number}>): BoardEdge[] {
  const shifts = new Map(nodes.flatMap(node => {
    const next = positions.get(node.id);
    return next ? [[node.id, { x: next.x - node.x, y: next.y - node.y }]] as const : [];
  }));
  return edges.map(edge => {
    const control = edge.route?.control;
    if (edge.route?.kind !== 'bent' || !control) return edge;
    const from = shifts.get(edge.from), to = shifts.get(edge.to);
    if (!from && !to) return edge;
    return { ...edge, route: { ...edge.route, control: {
      x: control.x + ((from?.x ?? 0) + (to?.x ?? 0)) / 2,
      y: control.y + ((from?.y ?? 0) + (to?.y ?? 0)) / 2,
    } } };
  });
}
