import type { BoardEdge, BoardNode } from '../api';
import { computeTreeLayout } from '../canvas/autoLayout';
import type { Box } from '../canvas/geometry';
import { measureNodes } from '../canvas/measureNodes';
import type { BoardAppearance } from '../canvas/presentation';
import type { StagedDocumentPreview } from '../components/NodeAttachment';

type Direction = 'down' | 'right';
type Density = 'compact' | 'balanced' | 'airy';
type BoardLayout = {
  projectId: string;
  boardId: string;
  name: string;
  direction: Direction;
  spacing: Density;
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

const SPACING: Record<Density, { hGap: number; vGap: number; treeGap: number }> = {
  compact: { hGap: 44, vGap: 76, treeGap: 128 },
  balanced: { hGap: 72, vGap: 110, treeGap: 240 },
  airy: { hGap: 128, vGap: 176, treeGap: 320 },
};

export function layoutBounds(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.w)), bottom = Math.max(...boxes.map(box => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

export async function measureWorkspaceLayout(job: LayoutJob, host: HTMLElement, scope: string, signal: AbortSignal, progress: (done: number) => void): Promise<MeasuredLayout> {
  const { projectId, boardId, nodes, edges, direction, spacing } = job;
  const sizes = await measureNodes(host, nodes, projectId, boardId, signal, progress, { appearance: job.appearance ?? undefined, documents: job.documents, scope });
  const horizontal = direction === 'right';
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const orderedEdges = [...edges].sort((a, b) => order.get(a.to)! - order.get(b.to)!);
  const positioned = computeTreeLayout(nodes.map(({ id }) => {
    const { w, h } = sizes.get(id)!;
    return { id, w: horizontal ? h : w, h: horizontal ? w : h };
  }), orderedEdges, { ...SPACING[spacing], originX: 0, originY: 0 });
  const boxes = nodes.map(({ id }) => {
    const { x, y } = positioned.get(id)!;
    return { id, x: horizontal ? y : x, y: horizontal ? x : y, ...sizes.get(id)! };
  });
  const bounds = layoutBounds(boxes);
  let x = Math.min(...nodes.map(node => node.x)), y = Math.min(...nodes.map(node => node.y));
  const reserved = job.reserved;
  const gap = SPACING[spacing].treeGap;
  if (reserved && x < reserved.x + reserved.w + gap && x + bounds.w > reserved.x - gap
      && y < reserved.y + reserved.h + gap && y + bounds.h > reserved.y - gap) {
    if (horizontal) x = reserved.x + reserved.w + gap;
    else y = reserved.y + reserved.h + gap;
  }
  return { projectId, boardId, nodes: Object.fromEntries(boxes.map(box => [box.id, {
    x: Math.ceil(box.x - bounds.x + x), y: Math.ceil(box.y - bounds.y + y), w: box.w, h: box.h,
  }])) };
}
