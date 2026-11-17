import { describe, it, expect } from 'vitest';
import { clipboardText, flowNodes, orderFlow, topLevelNodes, nonemptyNode } from './composition';
import type { BoardNode } from '../api';
const node = (id: string, owner?: string): BoardNode => ({ id, title: id, flowOwnerId: owner, x: 0, y: 0, w: 240, docs: [], created_at: '', updated_at: '' });
describe('composed nodes and linear subflows', () => {
  it('preserves long clipboard text exactly with a short Unicode title', () => {
    const raw = '# 一个完整的数学问题\r\n\r\n  $\\nu$  \r\n'.repeat(3), result = clipboardText(raw);
    expect(result.document).toBe(raw); expect(Array.from(result.title)).toHaveLength(10);
    expect(clipboardText('短问题')).toEqual({ title: '短问题' });
  });
  it('inserts and reorders a real chain without changing outside edges', () => {
    const owner = { ...node('owner'), flow: { nodeIds: ['a', 'b'] } }, a = node('a', 'owner'), b = node('b', 'owner');
    const outside = { id: 'outside', from: 'owner', to: 'normal', directed: true, created_at: '' }; let i = 0;
    const initial = orderFlow([owner, a, b, node('normal')], [outside], 'owner', ['a', 'b'], () => 'e' + i++);
    const inserted = orderFlow([...initial.nodes, node('x', 'owner')], initial.edges, 'owner', ['a', 'x', 'b'], () => 'e' + i++);
    expect(inserted.edges.map(e => [e.from, e.to])).toEqual([['owner', 'normal'], ['a', 'x'], ['x', 'b']]);
    const moved = orderFlow(inserted.nodes, inserted.edges, 'owner', ['b', 'a', 'x'], () => 'e' + i++);
    expect(flowNodes(moved.nodes[0], moved.nodes).map(n => n.id)).toEqual(['b', 'a', 'x']);
    expect(moved.edges[0]).toBe(outside); expect(topLevelNodes(moved.nodes).map(n => n.id)).toEqual(['owner', 'normal']);
    expect(topLevelNodes(moved.nodes.filter(n => n.id !== 'owner')).map(n => n.id)).toContain('a');
  });
  it('allows an empty heading with resources, but never an entirely blank node', () => {
    expect(nonemptyNode({ ...node('a'), title: '', docs: [{ path: 'docs/a.md', title: 'a' }] }).title).toBe('');
    expect(nonemptyNode({ ...node('a'), title: '' }).title).toBe('新问题');
  });
});
