import assert from 'node:assert/strict';
import test from 'node:test';

import { computeHierarchyLayout, getDirectFrontier, getDirectHierarchy, getPersistedBoardBounds, GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT } from '../components/hierarchy-layout';

test('free canvas includes negative positions without moving their world coordinates', () => {
  const points = [{x:-1400,y:-2300},{x:900,y:1000}];
  const board = getPersistedBoardBounds(points);
  for (const point of points) {
    const localX=point.x-board.minX; const localY=point.y-board.minY;
    assert(localX>=0 && localY>=0);
    assert(localX+GRAPH_NODE_WIDTH<=board.boardWidth && localY+GRAPH_NODE_HEIGHT<=board.boardHeight);
    for (const scale of [0.4,0.9,1.2]) {
      assert.equal(localX*scale+board.minX*scale,point.x*scale);
      assert.equal(localY*scale+board.minY*scale,point.y*scale);
    }
  }
});

const nodes = [
  { id: 'root', order: 0, x: 0, y: 0 },
  { id: 'a', order: 1, x: 0, y: 0 },
  { id: 'b', order: 2, x: 0, y: 0 },
  { id: 'a1', order: 3, x: 0, y: 0 },
  { id: 'orphan', order: 4, x: 0, y: 0 },
];
const edges = [
  { id: 'e1', sourceId: 'root', targetId: 'a' },
  { id: 'e2', sourceId: 'root', targetId: 'b' },
  { id: 'e3', sourceId: 'a', targetId: 'a1' },
];

test('lays out connected nodes by directed depth and leaves disconnected nodes last', () => {
  const result = computeHierarchyLayout(nodes, edges as never);
  assert.equal(result.positions.get('root')?.depth, 0);
  assert.equal(result.positions.get('a')?.depth, 1);
  assert.equal(result.positions.get('b')?.depth, 1);
  assert.equal(result.positions.get('a1')?.depth, 2);
  assert.equal(result.positions.get('orphan')?.depth, 3);
  assert.ok(result.positions.get('root')!.y < result.positions.get('a')!.y);
  assert.ok(result.positions.get('a')!.y < result.positions.get('a1')!.y);
  assert.ok(result.boardWidth >= 1_200);
});

test('horizontal layout advances hierarchy depth from left to right', () => {
  const result = computeHierarchyLayout(nodes, edges as never, 'horizontal');
  assert.ok(result.positions.get('root')!.x < result.positions.get('a')!.x);
  assert.ok(result.positions.get('a')!.x < result.positions.get('a1')!.x);
  assert.equal(result.positions.get('a')!.x, result.positions.get('b')!.x);
  assert.ok(result.boardWidth > 1_200);
});

test('keeps cycles bounded and returns deterministic positions', () => {
  const cyclic = [...edges, { id: 'cycle', sourceId: 'a1', targetId: 'a' }];
  const first = computeHierarchyLayout(nodes, cyclic as never);
  const second = computeHierarchyLayout([...nodes].reverse(), cyclic as never);
  assert.deepEqual([...first.positions.entries()], [...second.positions.entries()]);
});

test('returns only the selected node direct outgoing frontier', () => {
  const frontier = getDirectFrontier('root', edges as never);
  assert.deepEqual([...frontier.nodeIds].sort(), ['a', 'b']);
  assert.deepEqual([...frontier.edgeIds].sort(), ['e1', 'e2']);
});

test('distinguishes direct parents from direct children for focused graph rendering', () => {
  const hierarchy = getDirectHierarchy('a', edges as never);
  assert.deepEqual([...hierarchy.incomingNodeIds], ['root']);
  assert.deepEqual([...hierarchy.incomingEdgeIds], ['e1']);
  assert.deepEqual([...hierarchy.outgoingNodeIds], ['a1']);
  assert.deepEqual([...hierarchy.outgoingEdgeIds], ['e3']);
});
