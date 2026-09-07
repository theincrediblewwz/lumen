import { describe, it, expect } from 'vitest';
import { maskNodeRefs, unmaskNodeRefs } from './nodeRef';

describe('maskNodeRefs', () => {
  it('把 [[node:id]] 换成占位 token 并记录 id 顺序', () => {
    const { text, ids } = maskNodeRefs('看 [[node:n_1a07cee43a9d9f6a]] 总览');
    expect(ids).toEqual(['n_1a07cee43a9d9f6a']);
    expect(text).toContain('LUMENNODEREF0X');
    expect(text).not.toContain('[[node');
  });
  it('多个引用按序编号', () => {
    const { text, ids } = maskNodeRefs('[[node:a]] 和 [[node:b_c]]');
    expect(ids).toEqual(['a', 'b_c']);
    expect(text).toBe('LUMENNODEREF0X 和 LUMENNODEREF1X');
  });
  it('占位 token 不含会被 markdown/KaTeX 破坏的字符（无下划线）', () => {
    const { text } = maskNodeRefs('[[node:n_with_underscores]]');
    expect(/LUMENNODEREF\d+X/.test(text)).toBe(true);
    expect(text.includes('_')).toBe(false);
  });
  it('无引用时原样返回', () => {
    const { text, ids } = maskNodeRefs('普通文本');
    expect(text).toBe('普通文本');
    expect(ids).toEqual([]);
  });
});

describe('unmaskNodeRefs', () => {
  const titleOf = (id: string) => (id === 'n1' ? '总览' : id === 'n2' ? '张骞凿空西域' : null);

  it('把占位 token 换成显示标题的胶囊', () => {
    const { text, ids } = maskNodeRefs('[[node:n1]]');
    const html = unmaskNodeRefs(text, ids, titleOf);
    expect(html).toContain('data-node-id="n1"');
    expect(html).toContain('总览');
    expect(html).not.toContain('LUMENNODEREF');
    expect(html).toContain('class="node-ref"');
  });
  it('未知 id 标记 is-missing 但仍可点击', () => {
    const { text, ids } = maskNodeRefs('[[node:zzz]]');
    const html = unmaskNodeRefs(text, ids, titleOf);
    expect(html).toContain('is-missing');
    expect(html).toContain('未知节点');
    expect(html).toContain('data-node-id="zzz"');
  });
  it('同一 id 多次出现全部替换', () => {
    const { text, ids } = maskNodeRefs('[[node:n1]] ... [[node:n1]]');
    const html = unmaskNodeRefs(text, ids, titleOf);
    expect((html.match(/data-node-id="n1"/g) || []).length).toBe(2);
  });
  it('转义标题里的 HTML 特殊字符', () => {
    const html = unmaskNodeRefs('LUMENNODEREF0X', ['x'], () => '<b>危险</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>危险');
  });
});
