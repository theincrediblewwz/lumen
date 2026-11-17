import type { BoardNode, BoardEdge, DocRef } from '../api';
import { isQuestionDoc } from './presentation';

export const contentDocs = (node: BoardNode): DocRef[] => node.docs.filter(d => !isQuestionDoc(d.path));
export const imageDoc = (doc?: DocRef) => !!doc && /^docs\/sticker_[a-f0-9]+\.md$/i.test(doc.path);
export const nodeHeading = (node: BoardNode) => node.sticker ? '' : node.title;
export const imageOnly = (node: BoardNode) => !nodeHeading(node).trim() && !node.summary?.trim() && imageDoc(contentDocs(node)[0]);
export function nonemptyNode(node: BoardNode): BoardNode {
  return node.title.trim() || node.summary?.trim() || contentDocs(node).length || node.flow?.nodeIds.length
    ? node : { ...node, title: '新问题', sticker: false };
}
export function clipboardText(text: string): { title: string; document?: string } {
  if (Array.from(text.trim()).length <= 20) return { title: text };
  return { title: Array.from(text.trim().replace(/^[#>*\s-]+/, '').replace(/\s+/g,' ')).slice(0, 10).join(''), document: text };
}
export function flowNodes(owner: BoardNode, nodes: BoardNode[]): BoardNode[] {
  const members = new Map(nodes.filter(n => n.flowOwnerId === owner.id).map(n => [n.id, n]));
  return [...new Set([...(owner.flow?.nodeIds ?? []), ...members.keys()])].flatMap(id => members.has(id) ? [members.get(id)!] : []);
}
export function topLevelNodes(nodes: BoardNode[]): BoardNode[] {
  const owners = new Set(nodes.filter(n => n.flow && !n.flowOwnerId).map(n => n.id));
  return nodes.filter(n => !n.flowOwnerId || !owners.has(n.flowOwnerId));
}
/** Rebuild only the adjacent flow arrows, retaining all unrelated graph objects. */
export function orderFlow(nodes: BoardNode[], edges: BoardEdge[], ownerId: string, requested: string[], newEdgeId: () => string) {
  const owner = nodes.find(n => n.id === ownerId); if (!owner) return { nodes, edges };
  const members = flowNodes(owner, nodes), ids = new Set(members.map(n => n.id));
  const order = [...new Set([...requested.filter(id => ids.has(id)), ...members.map(n => n.id)])];
  const previous = new Map(edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => [`${e.from}/${e.to}`, e]));
  const nextEdges = edges.filter(e => !ids.has(e.from) || !ids.has(e.to));
  for (let i = 1; i < order.length; i++) nextEdges.push(previous.get(`${order[i - 1]}/${order[i]}`) ?? {
    id: newEdgeId(), from: order[i - 1], to: order[i], directed: true, created_at: new Date().toISOString(),
  });
  return { nodes: nodes.map(n => n.id === ownerId ? { ...n, flow: { nodeIds: order } } : n), edges: nextEdges };
}
export function moveFlowStep(order: string[], id: string, index: number): string[] {
  const next = order.filter(item => item !== id); next.splice(Math.max(0, Math.min(index, next.length)), 0, id); return next;
}
