import type { BoardFile, BoardNode } from '../api';
import { MAX_ARRANGEMENT_NODES, type LayoutDirection, type LayoutSpacing } from '../canvas/autoLayout';
import { topLevelNodes } from '../canvas/composition';
import { measureNodes } from '../canvas/measureNodes';
import { descendantIds } from '../canvas/subtree';
import { layoutBounds, placeMeasuredNodes } from './workspaceLayout';
import type { OperationBatch } from './boardOperations';

function knownIds(value: unknown, available: ReadonlyMap<string, BoardNode>): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ARRANGEMENT_NODES
      || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !available.has(id))) {
    throw Error('请提供仍在主白板上的唯一节点 ID，子流程步骤保持原顺序。');
  }
  return value;
}

function reservedBox(node: BoardNode) {
  const width = Math.max(node.w, node.docs[0]?.imageDisplay?.width ?? 0);
  const hasBody = !!node.summary?.trim();
  const hasAttachment = node.docs.some(doc => !doc.path.startsWith('docs/question_'));
  const height = node.h ?? (80 + 320 * (Number(hasBody) + Number(hasAttachment)) + 48 * Math.ceil(Array.from(node.title).length / 16));
  return { x: node.x, y: node.y, w: width, h: height };
}

/** Convert the model's layout intent into measured, display-only positions. */
export async function prepareBoardBatch(
  args: Record<string, unknown>, board: BoardFile, host: HTMLElement, scope: string,
  signal: AbortSignal, progress: (done: number, count: number) => void,
): Promise<OperationBatch> {
  if (args.schema !== 'lumen.board-operations/v1' || !Array.isArray(args.operations)) throw Error('白板操作协议无效。');
  if (args.operations.some(operation => operation?.type === 'place_measured_nodes')) throw Error('布局坐标由本机测量，请使用 arrange_nodes。');
  const intent = args.operations.find(operation => operation?.type === 'arrange_nodes');
  if (!intent) return { schema: 'lumen.board-operations/v1', operations: args.operations };
  if (args.operations.length !== 1) throw Error('请先提交节点、文档和连线，再单独发送一批 arrange_nodes。');
  const direction: LayoutDirection = intent.direction ?? 'auto';
  const spacing: LayoutSpacing = intent.spacing ?? 'balanced';
  if (!['auto', 'down', 'right'].includes(direction) || !['compact', 'balanced', 'airy'].includes(spacing)) {
    throw Error('布局方向或间距无效。');
  }

  const main = topLevelNodes(board.nodes);
  const available = new Map(main.map(node => [node.id, node]));
  const selection = intent.selection;
  let nodes: BoardNode[];
  let rootIds: string[] | undefined;
  if (selection?.kind === 'board') {
    nodes = main;
  } else if (selection?.kind === 'nodes') {
    nodes = knownIds(selection.nodeIds, available).map(id => available.get(id)!);
  } else if (selection?.kind === 'branches') {
    rootIds = knownIds(selection.rootIds, available);
    nodes = [...descendantIds(main, board.edges, rootIds)].map(id => available.get(id)!);
  } else {
    throw Error('请明确要整理整块白板、哪些节点或哪些分支。');
  }
  if (!nodes.length || nodes.length > MAX_ARRANGEMENT_NODES) throw Error(`每批可整理 1 到 ${MAX_ARRANGEMENT_NODES} 个主白板节点。`);
  const ids = new Set(nodes.map(node => node.id));
  const untouched = main.filter(node => !ids.has(node.id));
  const bounds = host.getBoundingClientRect();
  progress(0, nodes.length);
  const sizes = await measureNodes(host, nodes, board.projectId, board.id, signal, done => progress(done, nodes.length), {
    appearance: board.appearance, scope, preserveSize: true,
  });
  const placement = placeMeasuredNodes(nodes, board.edges, sizes, direction, spacing,
    untouched.length ? layoutBounds(untouched.map(reservedBox)) : undefined,
    { aspectRatio: bounds.width / Math.max(1, bounds.height), rootIds, stackRoots: selection.kind === 'branches' && selection.stack === true });
  return { schema: 'lumen.board-operations/v1', operations: [{ type: 'place_measured_nodes', positions: placement }] };
}
