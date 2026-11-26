import type { BoardEdge, BoardNode } from '../api';
import { computeBoardLayout, LAYOUT_SPACING, type LayoutDirection, type LayoutSpacing } from '../canvas/autoLayout';
import type { Box } from '../canvas/geometry';
import { measureNodes } from '../canvas/measureNodes';
import type { BoardAppearance } from '../canvas/presentation';
import type { StagedDocumentPreview } from '../components/NodeAttachment';

type BoardLayout = {
  projectId: string;
  boardId: string;
  name: string;
  direction: LayoutDirection;
  spacing: LayoutSpacing;
  reason: string;
  edges: BoardEdge[];
};
export type LayoutJob = BoardLayout & {
  nodes: BoardNode[];
  appearance?: BoardAppearance | null;
  reserved?: Box | null;
  documents: Record<string, StagedDocumentPreview>;
};
export type MeasuredLayout = { projectId: string; boardId: string; nodes: Record<string, Box> };
export type LayoutPreview = BoardLayout & { nodes: (Box & Pick<BoardNode, 'id' | 'title' | 'color'>)[] };

export function layoutBounds(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.w)), bottom = Math.max(...boxes.map(box => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

export async function measureWorkspaceLayout(job: LayoutJob, host: HTMLElement, scope: string, signal: AbortSignal, progress: (done: number) => void): Promise<MeasuredLayout> {
  const { projectId, boardId, nodes, edges, direction, spacing } = job;
  const sizes = await measureNodes(host, nodes, projectId, boardId, signal, progress, { appearance: job.appearance ?? undefined, documents: job.documents, scope });
  return { projectId, boardId, nodes: placeMeasuredNodes(nodes, edges, sizes, direction, spacing, job.reserved, {
    aspectRatio: window.innerWidth / Math.max(1, window.innerHeight),
  }) };
}

export function placeMeasuredNodes(
  nodes: BoardNode[], edges: BoardEdge[], sizes: ReadonlyMap<string, Pick<Box, 'w' | 'h'>>,
  direction: LayoutDirection, spacing: LayoutSpacing, reserved?: Box | null,
  options: { aspectRatio?: number; rootIds?: string[]; stackRoots?: boolean } = {},
): Record<string, Box> {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const orderedEdges = edges.filter(edge => order.has(edge.from) && order.has(edge.to))
    .sort((a, b) => order.get(a.to)! - order.get(b.to)!);
  const positioned = computeBoardLayout(nodes.map(({ id }) => ({ id, ...sizes.get(id)! })), orderedEdges, direction, spacing, options);
  const boxes = nodes.map(({ id }) => {
    const { x, y } = positioned.get(id)!;
    return { id, x, y, ...sizes.get(id)! };
  });
  const bounds = layoutBounds(boxes);
  let x = Math.min(...nodes.map(node => node.x)), y = Math.min(...nodes.map(node => node.y));
  const gap = LAYOUT_SPACING[spacing].treeGap;
  if (reserved && x < reserved.x + reserved.w + gap && x + bounds.w > reserved.x - gap
      && y < reserved.y + reserved.h + gap && y + bounds.h > reserved.y - gap) {
    const right = reserved.x + reserved.w + gap, below = reserved.y + reserved.h + gap;
    if (direction === 'right' || (direction === 'auto' && right - x < below - y)) x = right;
    else y = below;
  }
  return Object.fromEntries(boxes.map(box => [box.id, {
    x: Math.ceil(box.x - bounds.x + x), y: Math.ceil(box.y - bounds.y + y), w: box.w, h: box.h,
  }]));
}
