import { describe, it, expect } from 'vitest';
import { computeTreeLayout, type LayoutNode, type LayoutEdge } from './autoLayout';

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
