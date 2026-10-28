import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleCanvasIds } from '../components/canvas-visibility';

const nodes = 'abcdefg'.split('').map(id => ({ id }));
const edge = (sourceId: string, targetId: string, directed = true) => ({ sourceId, targetId, directed });

test('folding hides downstream only when no other visible parent can reach it', () => {
  const edges = [edge('a','b'), edge('b','c'), edge('d','c'), edge('c','e'), edge('f','g')];
  assert.deepEqual([...visibleCanvasIds(nodes, edges, ['b'])].sort(), 'ab cdefg'.replace(/ /g,'').split(''));
  assert.deepEqual([...visibleCanvasIds(nodes, edges, ['b','d'])].sort(), ['a','b','d','f','g']);
  assert.deepEqual([...visibleCanvasIds(nodes, edges, ['b','d'], 'f')].sort(), ['f','g']);
});

test('orphan nodes, undirected links and rootless cycles remain reachable', () => {
  const edges = [edge('a','b'), edge('b','c'), edge('c','b'), edge('a','d',false)];
  assert.deepEqual([...visibleCanvasIds(nodes, edges, ['a'])].sort(), nodes.map(node => node.id));
  assert.deepEqual([...visibleCanvasIds(nodes, edges, ['a'], 'd')].sort(), ['a','d']);
});
