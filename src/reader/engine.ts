/**
 * 阅读内核 · Markdown 引擎（M4-1）
 *
 * 设计目标（对齐 mdread 的渲染内核，主目标平台 macOS/WKWebView 效果优先）：
 *  1. 公式两级保护：块级 `$$…$$` 与行内 `$…$` 各自成 token，渲染为**占位元素**
 *     （带 data-tex），KaTeX 排版交给 DOM 层（reader）按空闲帧分批完成，
 *     避免大文档一次性同步排版卡顿（见 M4-8）。这样本引擎保持纯粹、可在
 *     Node 环境直接单测，不依赖 KaTeX/DOM。
 *  2. 标题锚点 slug：为每个标题生成稳定、去重的 id，供 TOC 跳转。
 *  3. TOC 收集：解析期一次遍历 token 得到层级目录。
 *
 * 纯函数：`slugify` / `renderMarkdown` 可脱离浏览器测试。
 */
import MarkdownIt from 'markdown-it';

// @types/markdown-it 用 `export =` 导出，命名空间类型无法经默认导入取到，
// 这里用宽松别名（token/state 均为运行时结构，逐字段访问已在下方各处收敛）。
type MD = InstanceType<typeof MarkdownIt>;
type Token = ReturnType<MD['parse']>[number];
type PluginSimple = (md: MD) => void;

export interface TocItem {
  level: number; // 1..6
  text: string;
  slug: string;
}

export interface RenderResult {
  html: string;
  toc: TocItem[];
}

/** HTML 属性值转义（占位元素把公式源码放进 data-tex）。 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成标题 slug：保留中英文与数字，空白转连字符，去掉其它符号。
 * 中文常见于本项目（问题/文档多为中文），因此不做 ASCII 化，直接保留。
 */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    // 允许：中日韩统一表意文字、字母、数字、连字符
    .replace(/[^\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'section';
}

/* ── 公式插件（行内 + 块级），思路参考 markdown-it-katex（MIT） ── */

/** 判断某个 `$` 是否可作为行内公式的开/闭定界符（避免 `$100` 之类误判）。 */
function isValidInlineDelim(src: string, pos: number) {
  const prev = pos > 0 ? src.charCodeAt(pos - 1) : -1;
  const next = pos + 1 <= src.length ? src.charCodeAt(pos + 1) : -1;
  let canOpen = true;
  let canClose = true;
  // 定界符后紧跟空白 → 不能作为开定界；前面是空白或后面是数字 → 不能作为闭定界
  if (next === 0x20 || next === 0x09) canOpen = false;
  if (prev === 0x20 || prev === 0x09 || (next >= 0x30 && next <= 0x39)) canClose = false;
  return { canOpen, canClose };
}

const mathPlugin: PluginSimple = (md) => {
  // 行内：$...$
  const mathInline = (state: any, silent: boolean): boolean => {
    if (state.src[state.pos] !== '$') return false;
    let res = isValidInlineDelim(state.src, state.pos);
    if (!res.canOpen) {
      if (!silent) state.pending += '$';
      state.pos += 1;
      return true;
    }
    const start = state.pos + 1;
    let match = start;
    // 找到未被转义的闭合 $
    for (;;) {
      match = state.src.indexOf('$', match);
      if (match === -1) break;
      let back = match - 1;
      let slashes = 0;
      while (back >= 0 && state.src[back] === '\\') {
        slashes += 1;
        back -= 1;
      }
      if (slashes % 2 === 0) break; // 偶数个反斜杠 → 真正的闭合
      match += 1;
    }
    if (match === -1) {
      if (!silent) state.pending += '$';
      state.pos = start;
      return true;
    }
    if (match - start === 0) {
      if (!silent) state.pending += '$$';
      state.pos = start + 1;
      return true;
    }
    res = isValidInlineDelim(state.src, match);
    if (!res.canClose) {
      if (!silent) state.pending += '$';
      state.pos = start;
      return true;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = '$';
      token.content = state.src.slice(start, match);
    }
    state.pos = match + 1;
    return true;
  };

  // 块级：$$ ... $$
  const mathBlock = (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];
    if (pos + 2 > max) return false;
    if (state.src.slice(pos, pos + 2) !== '$$') return false;
    pos += 2;
    let firstLine = state.src.slice(pos, max);
    if (silent) return true;

    let found = false;
    let lastLine = '';
    if (firstLine.trim().endsWith('$$')) {
      firstLine = firstLine.trim().slice(0, -2);
      found = true;
    }

    let next = startLine;
    while (!found) {
      next += 1;
      if (next >= endLine) break;
      pos = state.bMarks[next] + state.tShift[next];
      max = state.eMarks[next];
      if (pos < max && state.tShift[next] < state.blkIndent) break;
      const lineText = state.src.slice(pos, max);
      if (lineText.trim().endsWith('$$')) {
        const lastPos = state.src.slice(0, max).lastIndexOf('$$');
        lastLine = state.src.slice(pos, lastPos);
        found = true;
      }
    }

    state.line = next + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content =
      (firstLine.trim() ? firstLine + '\n' : '') +
      state.getLines(startLine + 1, next, state.tShift[startLine], true) +
      (lastLine.trim() ? lastLine : '');
    token.markup = '$$';
    token.map = [startLine, state.line];
    return true;
  };

  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.after('blockquote', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  // 渲染为占位元素：真正的 KaTeX 排版由 reader（DOM 层）分批完成
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) =>
    `<span class="math math-inline" data-tex="${escapeAttr(tokens[idx].content)}"></span>`;
  md.renderer.rules.math_block = (tokens: Token[], idx: number) =>
    `<div class="math math-block" data-tex="${escapeAttr(tokens[idx].content)}"></div>\n`;
};

/** 创建配置好的 markdown-it 实例（含公式插件）。 */
export function createEngine(): MD {
  const md = new MarkdownIt({
    html: false, // 不信任外部 md 的原始 HTML（安全）
    linkify: true,
    breaks: false,
    typographer: true,
  });
  md.use(mathPlugin);
  return md;
}

/**
 * 渲染 Markdown → { html, toc }。
 * 解析期一次遍历给标题打去重 slug 并收集目录，再渲染为 HTML。
 */
export function renderMarkdown(src: string, engine?: MD): RenderResult {
  const md = engine ?? createEngine();
  const env = {};
  const tokens = md.parse(src, env);
  const toc: TocItem[] = [];
  const used = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const level = Number(t.tag.slice(1)); // h2 -> 2
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    let slug = slugify(text);
    // 去重：重复标题追加 -2 / -3 …
    if (used.has(slug)) {
      const n = (used.get(slug) as number) + 1;
      used.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      used.set(slug, 1);
    }
    t.attrSet('id', slug);
    // 便于点击标题复制锚点（可选样式）
    t.attrJoin('class', 'md-heading');
    toc.push({ level, text, slug });
  }

  const html = md.renderer.render(tokens, md.options, env);
  return { html, toc };
}
