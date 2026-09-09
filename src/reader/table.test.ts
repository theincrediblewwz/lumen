import { describe, it, expect } from 'vitest';
import { renderMarkdown, preprocessGuessMath, normalizeTablePipes } from './engine';

/* ── 表格：分隔行不能被 guessMath 吃掉（用户报「表格压根没渲染」的主因）── */

describe('表格 - guessMath 不得破坏分隔行', () => {
  const src = '| 阶段 | 干什么 | 最终得到什么 |\n| --- | --- | --- |\n| 37 | 把 Rayleigh 化成通量系统 | F=K^2V^2h |';

  it('分隔行不被包成公式，表头行原样保留', () => {
    const out = preprocessGuessMath(src);
    const [head, delim] = out.split('\n');
    expect(head).toBe('| 阶段 | 干什么 | 最终得到什么 |');
    expect(delim).toBe('| --- | --- | --- |');
  });

  it('数据行保住竖线结构，只把单元格里的裸公式包起来', () => {
    const out = preprocessGuessMath(src);
    expect(out.split('\n')[2]).toBe('| 37 | 把 Rayleigh 化成通量系统 | $F=K^2V^2h$ |');
  });

  it('guessMath 开启时仍然渲染出 table', () => {
    const { html } = renderMarkdown(src, undefined, { guessMath: true });
    expect(html).toContain('<table>');
    expect(html).toContain('<th>阶段</th>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
  });

  it('guessMath 关闭时同样渲染出 table', () => {
    const { html } = renderMarkdown(src, undefined, { guessMath: false });
    expect(html).toContain('<table>');
  });

  it('对齐分隔行 :---: 也不被破坏', () => {
    const s = '| a | b |\n| :---: | ---: |\n| 1 | 2 |';
    expect(preprocessGuessMath(s)).toBe(s);
    const { html } = renderMarkdown(s, undefined, { guessMath: true });
    expect(html).toContain('<table>');
    expect(html).toContain('center');
  });
});

/* ── 表格：形近字符 / 不可见字符归一化 ── */

const ZW = '\u200B'; // 零宽空格：PDF/网页复制常混入
const PIPE = '\u2223'; // ∣ DIVIDES，形近 |
const DASH = '\u2212'; // − MINUS SIGN，形近 -

describe('normalizeTablePipes', () => {
  it('把形近竖线/横线换成 ASCII', () => {
    const out = normalizeTablePipes(`${PIPE}a${PIPE}b${PIPE}\n${PIPE}${DASH}${DASH}${DASH}${PIPE}${DASH}${DASH}${DASH}${PIPE}\n${PIPE}1${PIPE}2${PIPE}`);
    expect(out).toBe('|a|b|\n|---|---|\n|1|2|');
  });

  it('去掉零宽空格等不可见字符', () => {
    expect(normalizeTablePipes(`阶${ZW}段 干${ZW}什么`)).toBe('阶段 干什么');
  });

  it('不动代码围栏', () => {
    const src = '```\n' + PIPE + 'a' + PIPE + '\n```';
    expect(normalizeTablePipes(src)).toBe(src);
  });

  it('不动行内代码', () => {
    const src = '这里 `' + PIPE + 'x' + PIPE + '` 保持原样';
    expect(normalizeTablePipes(src)).toBe(src);
  });

  it('不动普通段落里的减号与中文', () => {
    const src = '温度是 −5 度，不是 5 度';
    expect(normalizeTablePipes(src)).toBe(src);
  });

  it('表头与分隔行之间多一个空行也能渲染', () => {
    const src = '| a | b |\n\n| --- | --- |\n| 1 | 2 |';
    expect(normalizeTablePipes(src)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });
});

describe('表格 - 脏表格（形近字符 + 零宽空格）整体渲染', () => {
  it('单元格里的竖线（范数 / 绝对值）不会让整格内容消失', () => {
    const src = [
      '| 阶段 | 干什么 | 结果 |',
      '| --- | --- | --- |',
      '| 71–78 | 证明两步复合是小映射 | |r[h]|≤γ(δ)|h| |',
    ].join('\n');
    const { html } = renderMarkdown(src, undefined, { guessMath: true });
    expect(html).toContain('<table>');
    // 多出来的单元格会被 markdown-it 丢掉，这里必须一个字不少
    expect(html).toContain('|r[h]|≤γ(δ)|h|');
  });

  it('形近竖线写成的范数同样保得住', () => {
    const src = [
      '| 阶段 | 结果 |',
      `${PIPE}${DASH}${DASH}${DASH}${PIPE}${DASH}${DASH}${DASH}${PIPE}`,
      `${PIPE}71${PIPE} 证明 ${PIPE} ${PIPE}r[h]${PIPE}≤γ(δ) ${PIPE}`,
    ].join('\n');
    const { html } = renderMarkdown(src, undefined, { guessMath: true });
    expect(html).toContain('<table>');
    expect(html).toContain('|r[h]|≤γ(δ)');
  });

  it('用户案例：带零宽空格与形近符号的表格能渲染', () => {
    const src = [
      `| 阶${ZW}段 | 干${ZW}什么 | 最终得到什么 |`,
      `${PIPE}${DASH}${DASH}${DASH}${PIPE}${DASH}${DASH}${DASH}${PIPE}${DASH}${DASH}${DASH}${PIPE}`,
      `${PIPE}37${PIPE} 把 Rayleigh 化${ZW}成通量系统 ${PIPE} F'=K^2V^2h ${PIPE}`,
      `${PIPE}38${PIPE} 在极远处选择衰减慢支 ${PIPE} h(Y)≈1 ${PIPE}`,
    ].join('\n');
    const { html } = renderMarkdown(src, undefined, { guessMath: true });
    expect(html).toContain('<table>');
    expect(html).toContain('<th>阶段</th>');
    expect(html).not.toContain('阶\u200B段');
  });
});
