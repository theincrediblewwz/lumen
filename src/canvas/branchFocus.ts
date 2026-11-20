import type { BoardEdge, BoardNode } from '../api';
import { computeTreeLayout } from './autoLayout';
import { flowNodes, topLevelNodes } from './composition';
import { descendantIds } from './subtree';
import { boxCenter, type Box, type Pt } from './geometry';
import type { Rect } from './CanvasEngine';

type Link = Pick<BoardEdge, 'id' | 'from' | 'to' | 'directed' | 'label' | 'route'>;
type Branch = { root: BoardNode; nodes: BoardNode[]; steps: BoardNode[]; edges: Link[]; flowEdges: Link[]; stepOffset: number };
type CardSize = Pick<Box, 'w' | 'h'>;

/** Flow steps are contained by their owner. Only the selected owner's flow is exposed. */
export function focusBranch(nodes: BoardNode[], edges: BoardEdge[], rootId: string): Branch | undefined {
  const root = nodes.find(node => node.id === rootId);
  if (!root) return;
  const main = topLevelNodes(nodes);
  const owner = root.flowOwnerId && nodes.find(node => node.id === root.flowOwnerId && node.flow);
  const selectedStep = !!owner && !main.some(node => node.id === rootId);
  const reachable = descendantIds(main, edges, rootId);
  const branchNodes = [root, ...main.filter(node => node.id !== rootId && reachable.has(node.id))];
  const branchEdges = edges.filter(edge => reachable.has(edge.from) && reachable.has(edge.to));
  const flow = selectedStep ? flowNodes(owner, nodes) : root.flow ? flowNodes(root, nodes) : [];
  const stepOffset = selectedStep ? flow.findIndex(step => step.id === rootId) + 1 : 0;
  const steps = flow.slice(stepOffset);
  const stepIds = new Set([root.id, ...steps.map(step => step.id)]);
  const flowEdges = steps.length ? edges.filter(edge => stepIds.has(edge.from) && stepIds.has(edge.to)) : [];
  return { root, nodes: branchNodes, steps, edges: branchEdges, flowEdges, stepOffset };
}

function remapBend(point: Pt, oldFrom: Box, oldTo: Box, from: Box, to: Box): Pt {
  const a = boxCenter(oldFrom), b = boxCenter(oldTo);
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  const c = boxCenter(from), d = boxCenter(to);
  if (!squared) return { x: point.x + c.x - a.x, y: point.y + c.y - a.y };
  const x = point.x - a.x, y = point.y - a.y;
  const along = (x * dx + y * dy) / squared, offset = (y * dx - x * dy) / squared;
  return { x: c.x + along * (d.x - c.x) - offset * (d.y - c.y), y: c.y + along * (d.y - c.y) + offset * (d.x - c.x) };
}

export function layoutFocusBranch(branch: Branch, measured: ReadonlyMap<string, CardSize>, viewportWidth: number) {
  const { root, nodes, steps, edges } = branch;
  const split = nodes.length > 1 && steps.length > 0;
  const maxTextWidth = Math.max(240, viewportWidth - 100);
  const sizeOf = (node: BoardNode, step = false) => measured.get(node.id) ?? {
    w: step ? Math.min(maxTextWidth, Math.max(400, node.w || 240)) : node.w || 240,
    h: node.h ?? (node.summary || node.docs.length ? 178 : 78),
  };
  const originalBox = (node: BoardNode) => ({ x: node.x, y: node.y, w: node.w || 240, h: node.h ?? sizeOf(node).h });
  const original = new Map(nodes.map(node => [node.id, originalBox(node)]));
  const branchSizes = nodes.map(node => ({ id: node.id, ...sizeOf(node) }));
  const positions = computeTreeLayout(branchSizes, edges.filter(edge => edge.directed && edge.to !== root.id), { originX: 0, originY: 0, vGap: 112 });
  const rootAt = positions.get(root.id)!;
  const rootSize = sizeOf(root);
  const center = rootAt.x + rootSize.w / 2;
  let branchRight = -Infinity;
  for (const node of branchSizes) if (node.id !== root.id) branchRight = Math.max(branchRight, positions.get(node.id)!.x + node.w - center);
  const shift = split ? Math.min(0, -56 - branchRight) : 0;
  const cards = nodes.map(node => {
    const at = positions.get(node.id)!;
    const box = { ...sizeOf(node), x: at.x - center + (node.id === root.id ? 0 : shift), y: at.y - rootAt.y };
    return { node: { ...node, x: box.x, y: box.y }, box, step: 0 };
  });
  const projected = new Map(cards.map(card => [card.node.id, card.box]));
  const links = edges.map(edge => {
    const point = edge.route?.control;
    return point ? { ...edge, route: { ...edge.route!, control: remapBend(point,
      original.get(edge.from)!, original.get(edge.to)!,
      projected.get(edge.from)!, projected.get(edge.to)!,
    ) } } : edge;
  });
  const savedSteps = new Map(branch.flowEdges.map(edge => [`${edge.from}/${edge.to}`, edge]));
  const workflow = new Set<string>();
  let y = rootSize.h + 112, previous = root.id;
  for (let index = 0; index < steps.length; index++) {
    const node = steps[index], size = sizeOf(node, true);
    const x = split ? 56 : -size.w / 2;
    const w = Math.min(maxTextWidth, Math.max(400, node.w || 240));
    cards.push({ node: { ...node, x, y, w }, box: { x, y, ...size }, step: branch.stepOffset + index + 1 });
    const saved = savedSteps.get(`${previous}/${node.id}`);
    const id = saved?.id ?? `focus-step-${index}`;
    links.push({ id, from: previous, to: node.id, label: saved?.label, directed: true });
    workflow.add(id);
    previous = node.id;
    y += size.h + 84;
  }

  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { box } of cards) {
    left = Math.min(left, box.x); top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w); bottom = Math.max(bottom, box.y + box.h);
  }
  for (const { route } of links) if (route?.control) {
    left = Math.min(left, route.control.x); top = Math.min(top, route.control.y);
    right = Math.max(right, route.control.x); bottom = Math.max(bottom, route.control.y);
  }
  const bounds: Rect = { x: left, y: top, width: right - left, height: bottom - top };
  return { cards, links, workflow, bounds };
}
