import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../reader/engine';
import { maskNodeRefs, unmaskNodeRefs } from './nodeRef';

// 模拟 AiChat.MessageBody 的渲染管线（guessMath:false）
function renderAi(content: string, titleOf: (id: string) => string | null): string {
  const { text, ids } = maskNodeRefs(content);
  const rendered = renderMarkdown(text, undefined, { guessMath: false }).html;
  return unmaskNodeRefs(rendered, ids, titleOf);
}

const titleOf = (id: string) =>
  ({ n1: '起点：张骞凿空西域', n2: '信仰的高速公路' } as Record<string, string>)[id] ?? null;

describe('AI 回答渲染管线（含表格/加粗/节点引用）', () => {
  const md = [
    '研究框架从四个维度切入：',
    '',
    '| 角度 | 对应节点 | 关键词 |',
    '| --- | --- | --- |',
    '| **如何开始** | [[node:n1]] | 张骞、汉武帝 |',
    '| **传播了什么** | [[node:n2]] | 佛教东传 |',
  ].join('\n');
  const html = renderAi(md, titleOf);

  it('渲染成真正的表格', () => {
    expect(html).toContain('<table>');
    expect(html).toContain('<th>');
    expect(html).toContain('<td>');
  });
  it('加粗正常，不出现 KaTeX 星号乱码 ∗', () => {
    expect(html).toContain('<strong>如何开始</strong>');
    expect(html).not.toContain('∗');
  });
  it('表格分隔符不被当公式，无 ∣ 乱码', () => {
    expect(html).not.toContain('∣');
    expect(html).not.toContain('−−−');
  });
  it('节点引用渲染成标题胶囊，非 id 代号', () => {
    expect(html).toContain('起点：张骞凿空西域');
    expect(html).toContain('data-node-id="n1"');
    expect(html).not.toContain('[[node');
    expect(html).not.toContain('&lt;a');
  });
  it('真正的公式仍能渲染（AI 自己写 $…$）', () => {
    const h = renderAi('时间约 $t = \\frac{d}{v}$ 天', () => null);
    // 公式先渲染成占位 span（浏览器里再由 typesetMath 排版）
    expect(h).toContain('math-inline');
    expect(h).toContain('data-tex="t = \\frac{d}{v}"');
  });
});
