import type { KnowledgeEdge, KnowledgeNode } from '@/types/domain';

type Node = Pick<KnowledgeNode, 'id'>;
type Edge = Pick<KnowledgeEdge, 'sourceId' | 'targetId' | 'directed'>;

export function visibleCanvasIds(nodes: Node[], edges: Edge[], collapsedIds: Iterable<string>, focusId: string | null = null): Set<string> {
  const all = new Set(nodes.map(node => node.id));
  const collapsed = new Set([...collapsedIds].filter(id => all.has(id)));
  const parents = new Map<string, Set<string>>(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.directed === false || edge.sourceId === edge.targetId || !all.has(edge.sourceId) || !all.has(edge.targetId)) continue;
    parents.get(edge.targetId)!.add(edge.sourceId);
  }
  const visible = new Set(all);
  // Remove a node only after every route into it is already hidden or folded.
  // This preserves alternate parents, orphan roots, and rootless cycles.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const incoming = parents.get(node.id)!;
      if (visible.has(node.id) && incoming.size > 0 && [...incoming].every(id => !visible.has(id) || collapsed.has(id))) {
        visible.delete(node.id);
        changed = true;
      }
    }
  }
  if (!focusId || !visible.has(focusId)) return visible;
  const nearby = new Set([focusId]);
  for (const edge of edges) {
    if (edge.sourceId === focusId && visible.has(edge.targetId)) nearby.add(edge.targetId);
    if (edge.targetId === focusId && visible.has(edge.sourceId)) nearby.add(edge.sourceId);
  }
  return nearby;
}
