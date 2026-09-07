import { describe, it, expect } from 'vitest';
import { renderMarkdown, slugify, createEngine } from './engine';

describe('slugify', () => {
  it('英文标题转小写连字符', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
  it('保留中文', () => {
    expect(slugify('第一章 引论')).toBe('第一章-引论');
  });
  it('去掉标点符号', () => {
    expect(slugify('What is X? (v2)')).toBe('what-is-x-v2');
  });
  it('空/纯符号回退 section', () => {
    expect(slugify('!!!')).toBe('section');
    expect(slugify('   ')).toBe('section');
  });
});

describe('renderMarkdown - 基础', () => {
  it('渲染段落与强调', () => {
    const { html } = renderMarkdown('这是 **粗体** 与 *斜体*。');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
  });

  it('渲染有序/无序列表', () => {
    const { html } = renderMarkdown('- a\n- b\n\n1. x\n2. y');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>a</li>');
  });

  it('渲染代码块并转义', () => {
    const { html } = renderMarkdown('```\nconst x = 1 < 2;\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&lt; 2');
  });

  it('不信任原始 HTML（html:false）', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('linkify 自动识别裸链接', () => {
    const { html } = renderMarkdown('见 https://example.com 说明');
    expect(html).toContain('<a href="https://example.com"');
  });
});

describe('renderMarkdown - 标题锚点与 TOC', () => {
  it('标题带 id 且收集进 toc', () => {
    const { html, toc } = renderMarkdown('# 标题一\n\n## 小节 A\n\n## 小节 B');
    expect(html).toContain('id="标题一"');
    expect(html).toContain('id="小节-a"');
    expect(toc).toHaveLength(3);
    expect(toc[0]).toMatchObject({ level: 1, text: '标题一', slug: '标题一' });
    expect(toc[1]).toMatchObject({ level: 2, text: '小节 A', slug: '小节-a' });
  });

  it('重复标题 slug 去重', () => {
    const { toc } = renderMarkdown('## 概述\n\n## 概述\n\n## 概述');
    expect(toc.map((t) => t.slug)).toEqual(['概述', '概述-2', '概述-3']);
  });

  it('标题加 md-heading 类', () => {
    const { html } = renderMarkdown('# 标题');
    expect(html).toContain('class="md-heading"');
  });
});

describe('renderMarkdown - 公式两级保护', () => {
  it('行内公式渲染为占位元素并保留源码', () => {
    const { html } = renderMarkdown('质能方程 $E=mc^2$ 很有名');
    expect(html).toContain('class="math math-inline"');
    expect(html).toContain('data-tex="E=mc^2"');
    // 不应把 $ 之间内容当普通文本原样输出
    expect(html).not.toContain('E=mc^2</p>');
  });

  it('块级公式渲染为块级占位元素', () => {
    const { html } = renderMarkdown('$$\n\\int_0^1 x\\,dx = \\frac12\n$$');
    expect(html).toContain('class="math math-block"');
    expect(html).toContain('data-tex="\\int_0^1');
  });

  it('公式源码里的 HTML 特殊字符被转义进 data-tex', () => {
    const { html } = renderMarkdown('$a < b$');
    expect(html).toContain('data-tex="a &lt; b"');
    expect(html).not.toContain('<b'); // 不会被当成标签
  });

  it('货币金额不误判为公式', () => {
    const { html } = renderMarkdown('售价 $100 与 $200 两档');
    expect(html).not.toContain('math-inline');
    expect(html).toContain('$100');
  });

  it('转义的 \\$ 不触发公式', () => {
    const { html } = renderMarkdown('价格是 \\$5 元');
    expect(html).not.toContain('math-inline');
  });

  it('单例引擎可复用（多次渲染互不污染 slug）', () => {
    const eng = createEngine();
    const a = renderMarkdown('## 概述', eng);
    const b = renderMarkdown('## 概述', eng);
    expect(a.toc[0].slug).toBe('概述');
    expect(b.toc[0].slug).toBe('概述'); // 每次 render 独立计数，不跨调用累积
  });
});
