import { expect, it } from 'vitest';
import type { BoardEdge, BoardNode } from '../api';
import { focusBranch, layoutFocusBranch } from './branchFocus';

const node = (id: string, fields: Partial<BoardNode> = {}): BoardNode => ({
  id, title: id, x: 100, y: 100, w: 240, docs: [], created_at: '', updated_at: '', ...fields,
});
const edge = (from: string, to: string, fields: Partial<BoardEdge> = {}): BoardEdge => ({
  id: `${from}-${to}`, from, to, created_at: '', directed: true, ...fields,
});

it('follows outgoing arrows through all levels and only opens the selected node’s flow', () => {
  const nodes = [node('parent'), node('sibling'), node('b', { flow: { nodeIds: ['s2', 's1'] } }),
    node('child', { flow: { nodeIds: ['closed'] } }), node('leaf'), node('related'),
    node('s1', { flowOwnerId: 'b' }), node('s2', { flowOwnerId: 'b' }), node('closed', { flowOwnerId: 'child' })];
  const edges = [edge('parent', 'b'), edge('parent', 'sibling'), edge('b', 'child'), edge('child', 'leaf'),
    edge('leaf', 'b'), edge('b', 'related', { directed: false }), edge('s2', 's1', { label: '继续 $x$' })];
  const branch = focusBranch(nodes, edges, 'b')!;
  expect(branch.nodes.map(node => node.id)).toEqual(['b', 'child', 'leaf']);
  expect(branch.steps.map(node => node.id)).toEqual(['s2', 's1']);
  expect(branch.edges.map(edge => edge.id)).toEqual(['b-child', 'child-leaf', 'leaf-b']);
  const step = focusBranch(nodes, edges, 's2')!;
  expect(step.nodes.map(node => node.id)).toEqual(['s2']);
  expect(step.steps.map(node => node.id)).toEqual(['s1']);
  expect(step.flowEdges[0]?.label).toBe('继续 $x$');
});

it('keeps the workflow and descendants apart after image dimensions are measured', () => {
  const nodes = [node('root', { flow: { nodeIds: ['photo', 'next'] } }), node('child'),
    node('photo', { flowOwnerId: 'root' }), node('next', { flowOwnerId: 'root' })];
  const edges = [edge('root', 'child'), edge('photo', 'next')];
  const before = structuredClone({ nodes, edges });
  const branch = focusBranch(nodes, edges, 'root')!;
  const scene = layoutFocusBranch(branch, new Map([['photo', { w: 920, h: 460 }]]), 1280);
  const [root, child, photo, next] = scene.cards.map(card => card.box);
  expect(root.x + root.w / 2).toBe(0);
  expect(photo.x).toBeGreaterThan(child.x + child.w);
  expect(next.y).toBeGreaterThan(photo.y + photo.h);
  expect(scene.links.map(edge => `${edge.from}/${edge.to}`)).toEqual(['root/child', 'root/photo', 'photo/next']);
  expect({ nodes, edges }).toEqual(before);
});
