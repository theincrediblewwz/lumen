import type { KnowledgeEdge, KnowledgeNode, LayoutDirection } from '@/types/domain';

export const GRAPH_NODE_WIDTH = 184;
export const GRAPH_NODE_HEIGHT = 82;
export const GRAPH_BOARD_WIDTH = 1200;

const HORIZONTAL_GAP = 64;
const VERTICAL_GAP = 84;
const TOP_PADDING = 96;
const SIDE_PADDING = 76;
const ROW_GAP = 206;
const COLUMN_GAP = 286;
const MAX_PER_ROW = 4;

export type HierarchyPosition = { x: number; y: number; depth: number };

export function getDirectHierarchy(selectedId: string | null, edges: KnowledgeEdge[]) {
  const incomingEdgeIds = new Set<string>();
  const incomingNodeIds = new Set<string>();
  const outgoingEdgeIds = new Set<string>();
  const outgoingNodeIds = new Set<string>();
  if (!selectedId) return { incomingEdgeIds, incomingNodeIds, outgoingEdgeIds, outgoingNodeIds };
  for (const edge of edges) {
    if (edge.targetId === selectedId) {
      incomingEdgeIds.add(edge.id);
      incomingNodeIds.add(edge.sourceId);
    }
    if (edge.sourceId === selectedId) {
      outgoingEdgeIds.add(edge.id);
      outgoingNodeIds.add(edge.targetId);
    }
  }
  return { incomingEdgeIds, incomingNodeIds, outgoingEdgeIds, outgoingNodeIds };
}

export function getDirectFrontier(selectedId: string | null, edges: KnowledgeEdge[]) {
  const hierarchy = getDirectHierarchy(selectedId, edges);
  return { edgeIds: hierarchy.outgoingEdgeIds, nodeIds: hierarchy.outgoingNodeIds };
}

export function computeHierarchyLayout(
  nodes: Pick<KnowledgeNode, 'id' | 'order' | 'x' | 'y'>[],
  edges: Pick<KnowledgeEdge, 'sourceId' | 'targetId'>[],
  direction: LayoutDirection = 'vertical',
) {
  const positions = new Map<string, HierarchyPosition>();
  if (!nodes.length) return { positions, boardWidth: GRAPH_BOARD_WIDTH, boardHeight: 1600 };

  const ordered = [...nodes].sort(compareNodeOrder);
  const nodeIds = new Set(ordered.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const node of ordered) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId) || edge.sourceId === edge.targetId) continue;
    adjacency.get(edge.sourceId)!.push(edge.targetId);
  }
  for (const targets of adjacency.values()) targets.sort((a, b) => orderIndex(ordered, a) - orderIndex(ordered, b));

  const depth = new Map<string, number>();
  const rootId = ordered[0].id;
  const queue: string[] = [rootId];
  depth.set(rootId, 0);
  while (queue.length) {
    const sourceId = queue.shift()!;
    const nextDepth = (depth.get(sourceId) ?? 0) + 1;
    for (const targetId of adjacency.get(sourceId) ?? []) {
      if (depth.has(targetId)) continue;
      depth.set(targetId, nextDepth);
      queue.push(targetId);
    }
  }

  const maxConnectedDepth = Math.max(0, ...depth.values());
  for (const node of ordered) {
    if (!depth.has(node.id)) depth.set(node.id, maxConnectedDepth + 1);
  }

  const groups = new Map<number, typeof ordered>();
  for (const node of ordered) {
    const nodeDepth = depth.get(node.id)!;
    const group = groups.get(nodeDepth) ?? [];
    group.push(node);
    groups.set(nodeDepth, group);
  }

  if (direction === 'horizontal') {
    const orderedDepths = [...groups.keys()].sort((a, b) => a - b);
    const maxInColumn = Math.max(1, ...orderedDepths.map((nodeDepth) => groups.get(nodeDepth)!.length));
    const boardHeight = Math.max(
      1_200,
      TOP_PADDING * 2 + maxInColumn * GRAPH_NODE_HEIGHT + Math.max(0, maxInColumn - 1) * VERTICAL_GAP,
    );
    for (const nodeDepth of orderedDepths) {
      const group = groups.get(nodeDepth)!;
      const height = group.length * GRAPH_NODE_HEIGHT + Math.max(0, group.length - 1) * VERTICAL_GAP;
      const startY = Math.max(TOP_PADDING, (boardHeight - height) / 2);
      group.forEach((node, index) => {
        positions.set(node.id, {
          x: SIDE_PADDING + nodeDepth * COLUMN_GAP,
          y: Math.round(startY + index * (GRAPH_NODE_HEIGHT + VERTICAL_GAP)),
          depth: nodeDepth,
        });
      });
    }
    return {
      positions,
      boardWidth: Math.max(GRAPH_BOARD_WIDTH, SIDE_PADDING * 2 + orderedDepths.length * COLUMN_GAP + GRAPH_NODE_WIDTH),
      boardHeight,
    };
  }

  let visualRow = 0;
  for (const nodeDepth of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(nodeDepth)!;
    for (let offset = 0; offset < group.length; offset += MAX_PER_ROW) {
      const row = group.slice(offset, offset + MAX_PER_ROW);
      const width = row.length * GRAPH_NODE_WIDTH + Math.max(0, row.length - 1) * HORIZONTAL_GAP;
      const startX = Math.max(38, (GRAPH_BOARD_WIDTH - width) / 2);
      row.forEach((node, index) => {
        positions.set(node.id, {
          x: Math.round(startX + index * (GRAPH_NODE_WIDTH + HORIZONTAL_GAP)),
          y: TOP_PADDING + visualRow * ROW_GAP,
          depth: nodeDepth,
        });
      });
      visualRow += 1;
    }
  }

  return {
    positions,
    boardWidth: GRAPH_BOARD_WIDTH,
    boardHeight: Math.max(1600, TOP_PADDING + visualRow * ROW_GAP + GRAPH_NODE_HEIGHT + 260),
  };
}

export function getPersistedBoardBounds(nodes: Pick<KnowledgeNode, 'x' | 'y'>[]) {
  const minX = Math.min(0, ...nodes.map((node) => node.x));
  const minY = Math.min(0, ...nodes.map((node) => node.y));
  const maxX = Math.max(0, ...nodes.map((node) => node.x + GRAPH_NODE_WIDTH));
  const maxY = Math.max(0, ...nodes.map((node) => node.y + GRAPH_NODE_HEIGHT));
  return {
    minX, minY,
    boardWidth: Math.max(GRAPH_BOARD_WIDTH, Math.ceil(maxX - minX + 180)),
    boardHeight: Math.max(1_200, Math.ceil(maxY - minY + 260)),
  };
}

function compareNodeOrder(a: Pick<KnowledgeNode, 'id' | 'order' | 'x' | 'y'>, b: Pick<KnowledgeNode, 'id' | 'order' | 'x' | 'y'>) {
  const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
  return aOrder - bOrder || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

function orderIndex(nodes: Pick<KnowledgeNode, 'id'>[], id: string) {
  const index = nodes.findIndex((node) => node.id === id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
