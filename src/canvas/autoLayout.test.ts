import { describe, it, expect } from 'vitest';
import { computeAdaptiveTreeLayout, computeBoardLayout, computeTreeLayout, type LayoutNode, type LayoutEdge } from './autoLayout';

const n = (id: string, w = 200): LayoutNode => ({ id, w });
const de = (from: string, to: string): LayoutEdge => ({ from, to, directed: true });
const ue = (from: string, to: string): LayoutEdge => ({ from, to, directed: false });

describe('computeTreeLayout', () => {
  it('空图返回空', () => {
    expect(computeTreeLayout([], []).size).toBe(0);
  });

  it('所有节点都有坐标', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges = [de('a', 'b'), de('a', 'c')];
    const pos = computeTreeLayout(nodes, edges);
    expect(pos.size).toBe(3);
    for (const id of ['a', 'b', 'c']) expect(pos.get(id)).toBeTruthy();
  });

  it('子节点在父节点下一层（y 更大）', () => {
    const pos = computeTreeLayout([n('a'), n('b')], [de('a', 'b')]);
    expect(pos.get('b')!.y).toBeGreaterThan(pos.get('a')!.y);
  });

  it('父节点水平居中于两个子节点之间', () => {
    const nodes = [n('root'), n('l'), n('r')];
    const pos = computeTreeLayout(nodes, [de('root', 'l'), de('root', 'r')]);
    const rootC = pos.get('root')!.x + 100;
    const lC = pos.get('l')!.x + 100;
    const rC = pos.get('r')!.x + 100;
    expect(rootC).toBeCloseTo((lC + rC) / 2, 0);
  });

  it('同层兄弟不重叠（间距 >= 宽度）', () => {
    const nodes = [n('root'), n('l', 200), n('r', 200)];
    const pos = computeTreeLayout(nodes, [de('root', 'l'), de('root', 'r')], { hGap: 40 });
    const gap = Math.abs(pos.get('r')!.x - pos.get('l')!.x);
    expect(gap).toBeGreaterThanOrEqual(200); // 至少一个节点宽
  });

  it('森林：多个根都被布局，横向排开', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')];
    const edges = [de('a', 'b'), de('c', 'd')];
    const pos = computeTreeLayout(nodes, edges);
    expect(pos.size).toBe(4);
    // 两棵树不应重叠：c 应在 a 的子树右侧
    expect(pos.get('c')!.x).toBeGreaterThan(pos.get('a')!.x);
  });

  it('孤立节点也有坐标', () => {
    const nodes = [n('a'), n('lonely')];
    const pos = computeTreeLayout(nodes, [de('a', 'a')]); // 自环忽略
    expect(pos.get('lonely')).toBeTruthy();
    expect(pos.get('a')).toBeTruthy();
  });

  it('环不会死循环，且所有节点被放置', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges = [de('a', 'b'), de('b', 'c'), de('c', 'a')]; // 环
    const pos = computeTreeLayout(nodes, edges);
    expect(pos.size).toBe(3);
  });

  it('无向边也能构建层级', () => {
    const pos = computeTreeLayout([n('a'), n('b')], [ue('a', 'b')]);
    expect(pos.get('a')!.y).not.toBe(pos.get('b')!.y);
  });

  it('尊重 origin 选项', () => {
    const pos = computeTreeLayout([n('a')], [], { originX: 500, originY: 300 });
    // 单节点：x 左上 = originX（中心 - w/2 == originX）
    expect(pos.get('a')!.y).toBe(300);
  });
});

it('stacks wide sibling subtrees while keeping their children in readable horizontal rows', () => {
  const roots = ['daily', 'plans', 'research'];
  const leaves = roots.map(id => Array.from({ length: 7 }, (_, index) => id + index));
  const nodes = ['main', ...roots, ...leaves.flat()].map(id => ({ id, w: 230, h: 100 }));
  const edges = roots.flatMap((id, index) => [de('main', id), ...leaves[index].map(child => de(id, child))]);
  const view = { originX: 0, originY: 0 };
  const classic = computeTreeLayout(nodes, edges, view);
  const arranged = computeAdaptiveTreeLayout(nodes, edges, { ...view, aspectRatio: 1.6 });
  const extent = (points: Map<string, { x: number; y: number }>) => Math.max(
    Math.max(...nodes.map(node => points.get(node.id)!.x + node.w)) / 1.6,
    Math.max(...nodes.map(node => points.get(node.id)!.y + node.h)),
  );
  expect(extent(arranged)).toBeLessThan(extent(classic) * .6);
  expect(new Set(roots.map(id => arranged.get(id)!.x)).size).toBe(1);
  expect(roots.map(id => arranged.get(id)!.y)).toEqual(roots.map(id => arranged.get(id)!.y).sort((a, b) => a - b));
  for (const group of leaves) {
    expect(new Set(group.map(id => arranged.get(id)!.y)).size).toBe(1);
    expect(arranged.get(group[0])!.x).toBeLessThan(arranged.get(group.at(-1)!)!.x);
  }
});

it('keeps chosen roots separate and honors stacking order even when a cross-link joins them', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, w: 230, h: 100 }));
  const positions = computeBoardLayout(nodes, [de('a','b'), de('b','c'), de('d','e'), de('e','f'), de('d','a')], 'right', 'balanced', {
    rootIds: ['d', 'a'], stackRoots: true,
  });
  expect(positions.size).toBe(nodes.length);
  expect(positions.get('d')!.x).toBe(positions.get('a')!.x);
  expect(positions.get('d')!.y).toBeLessThan(positions.get('a')!.y);
  expect(positions.get('c')!.x).toBeGreaterThan(positions.get('b')!.x);
  expect(positions.get('c')!.y).toBe(positions.get('a')!.y);
});
