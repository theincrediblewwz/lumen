import type { BoardEdge, BoardNode } from '../api';

/** Follow question arrows only. Iterative traversal handles deep graphs and cycles. */
export function descendantIds(nodes:Pick<BoardNode,'id'>[],edges:Pick<BoardEdge,'from'|'to'|'directed'>[],root:string):Set<string>{
  const valid=new Set(nodes.map(n=>n.id)),next=new Map<string,string[]>();
  if(!valid.has(root))return new Set();
  for(const e of edges)if(e.directed&&valid.has(e.from)&&valid.has(e.to)){const row=next.get(e.from)??[];row.push(e.to);next.set(e.from,row);}
  const visited=new Set([root]),queue=[root];
  for(let index=0;index<queue.length;index++)for(const child of next.get(queue[index])??[])if(!visited.has(child)){visited.add(child);queue.push(child);}
  return visited;
}

export function translateFromBaseline(nodes:BoardNode[],baseline:ReadonlyMap<string,{x:number;y:number}>,dx:number,dy:number):BoardNode[]{
  if(!Number.isFinite(dx)||!Number.isFinite(dy))return nodes;
  return nodes.map(node=>{const start=baseline.get(node.id);return start?{...node,x:start.x+dx,y:start.y+dy}:node;});
}
