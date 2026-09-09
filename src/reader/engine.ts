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
  text: string; // 纯文本（tooltip / 无障碍用）
  /** 标题内联渲染后的 HTML（含公式占位元素），供 TOC 也能显示/排版公式 */
  html: string;
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

/* ── 定界符归一化：把 LaTeX/GPT 常见的 \(…\) \[…\] 转成 $…$ / $$…$$ ── */

/**
 * 归一化数学定界符（始终执行，与 guessMath 无关）：
 *  - `\(  …  \)`  → `$…$`   （行内）
 *  - `\[  …  \]`  → `$$…$$`（块级，两侧补空行以便 markdown-it 块规则识别）
 *  - 独占整行、以 `$$` 成对包裹的行保持不变。
 *
 * 这是「公式变红不渲染」的主因修复：GPT 导出的正文里公式常用 \(\) \[\]，
 * 之前引擎只认 $，未转换的 `\(` 残留后又被猜测渲染裹进公式 → KaTeX 报错标红。
 * 跳过代码围栏与行内代码，避免误伤代码里的反斜杠。
 */
export function normalizeMathDelims(src: string): string {
  // 先按代码围栏切块（奇数段是围栏，原样保留）
  const parts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : convertDelimsOutsideCode(part)))
    .join('');
}

function convertDelimsOutsideCode(text: string): string {
  // 保护行内代码 `…`（奇数段），只在普通段转换
  const segs = text.split(/(`[^`\n]*`)/g);
  return segs
    .map((s, i) => {
      if (i % 2 === 1) return s;
      return s
        .replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, (_m, inner) => `\n\n$$\n${inner}\n$$\n\n`)
        .replace(/\\\(\s*([\s\S]+?)\s*\\\)/g, (_m, inner) => `$${inner}$`);
    })
    .join('');
}

/* ── 表格归一化：把「用了形近/不可见字符」的表格救回来（M4-9） ── */

/**
 * 从 PDF / 网页 / 部分 AI 输出里复制出来的 Markdown，表格常被这些字符污染：
 *  - 不可见字符（零宽空格 U+200B、词连接符 U+2060、BOM U+FEFF、软连字符 U+00AD）：
 *    混在字里行间，「阶段」变成「阶<ZWSP>段」，复制、搜索、断行都受影响；
 *  - 形近竖线 ∣ │ ｜ ❙：markdown-it 只认 ASCII `|`，用了它们就拆不出单元格；
 *  - 形近横线 − – — ─ － ‐ ‑：分隔行 `∣−−−∣` 不合法 → 整张表降级成普通段落。
 *
 * 处理策略（保守）：
 *  - 代码围栏 ``` 与行内代码 `…` 内原样保留；
 *  - 不可见字符与形近竖线全局替换（它们在正文里没有正当用途）；
 *  - 形近横线只在「分隔行」里替换，避免误伤正文里的减号/破折号；
 *  - 表头与分隔行之间若夹了空行（AI 导出常见），去掉空行让表格重新成立。
 */
const INVISIBLE_CHARS = /[\u200B\u2060\uFEFF\u00AD]/g;
const PIPE_ALIKE = /[\u2223\u2502\uFF5C\u2758]/g;
const DASH_ALIKE = /[\u2212\u2013\u2014\u2500\uFF0D\u2010\u2011]/g;
/** 分隔行：只含竖线、冒号、空白与各种横线，如 `|---|` `| :---: |---:|` */
const DELIM_ROW = /^\|?[\s:|\-−–—─－‐‑]*\|[\s:|\-−–—─－‐‑]*$/;
const HAS_DASH = /[\-−–—─－‐‑]/;

export function normalizeTablePipes(src: string): string {
  const parts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : normalizeTableOutsideCode(part))).join('');
}

function normalizeTableOutsideCode(text: string): string {
  const segs = text.split(/(`[^`\n]*`)/g);
  return segs.map((s, i) => (i % 2 === 1 ? s : normalizeTableLines(s))).join('');
}

function normalizeTableLines(text: string): string {
  const lines = text.split('\n').map((line) => {
    const clean = line.replace(INVISIBLE_CHARS, '').replace(PIPE_ALIKE, '|');
    const t = clean.trim();
    return DELIM_ROW.test(t) && HAS_DASH.test(t) ? clean.replace(DASH_ALIKE, '-') : clean;
  });
  // 表头与分隔行之间夹了空行（AI 导出常见）→ 去掉空行，让表格重新成立
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i].trimStart().startsWith('|') && lines[i + 1].trim() === '' && DELIM_ROW.test(lines[i + 2].trim())) {
      lines.splice(i + 1, 1);
    }
  }
  // 单元格里含未转义竖线（数学范数 |r[h]| 之类）时，多出来的单元格会被
  // markdown-it 直接丢弃 → 整格内容凭空消失。按表头列数并回最后一格。
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('|')) continue;
    if (!DELIM_ROW.test(lines[i + 1].trim())) continue;
    const cols = Math.min(splitTableRow(lines[i]).cells.length, splitTableRow(lines[i + 1]).cells.length);
    if (cols < 1) continue;
    for (let j = i + 2; j < lines.length; j++) {
      if (!isTableRowShape(lines[j])) break;
      lines[j] = mergeExtraCells(lines[j], cols);
    }
  }
  return lines.join('\n');
}

/** 数据行 / 表头行：首尾至少一端带竖线（分隔行不算） */
function isTableRowShape(line: string): boolean {
  const s = line.trim();
  if (!s || DELIM_ROW.test(s)) return false;
  return s.startsWith('|') || s.endsWith('|');
}

/**
 * 把超出列数的单元格并回最后一格，多出来的竖线转义成 `\|`：
 * 结构保住、内容一个字不少，渲染出来仍是原本的 `|r[h]|`。
 * 例（3 列）：`| 71 | 证… | |r[h]|≤γ(δ)|h| |` → `| 71 | 证… | \|r[h]\|≤γ(δ)\|h\| |`
 */
function mergeExtraCells(line: string, cols: number): string {
  const { head, cells, tail } = splitTableRow(line);
  if (cells.length <= cols) return line;
  const keep = cells.slice(0, cols - 1);
  const merged = cells
    .slice(cols - 1)
    .join('\\|')
    .trim();
  return head + keep.concat(merged).join('|') + tail;
}

/* ── 猜测渲染：识别未用 $ 分界符、但明显是数学的行内片段 ── */

/**
 * 判断一个片段「像不像数学」：含 LaTeX 命令(\alpha \sim \frac…)、上/下标(^ _)、
 * 或典型数学符号组合。用于 guessMath：把这类裸片段自动包成行内公式。
 * 保守判定，尽量不误伤普通文本/代码。
 */
export function looksLikeMath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // 纯自然语言单词（全字母、无数学符号）直接排除，避免误伤英文
  if (/^[A-Za-z]+$/.test(t)) return false;
  // 1) 含 LaTeX 反斜杠命令：\varepsilon \sim \frac \alpha 等
  if (/\\[a-zA-Z]+/.test(t)) return true;
  // 2) 真正的上标/下标：必须「有底数 + ^/_ + 花括号或单个字母数字（其后不接字母）」，
  //    这样能命中 x^2 / a_{ij} / |x|^{1/3} / 10^{-3}，但排除 _TS_（前导下划线强调）、
  //    snake_case_name（下划线连接的单词）这类非公式。
  if (/[A-Za-z0-9)\]}|]\s*[\^_]\s*(\{|[A-Za-z0-9](?![A-Za-z]))/.test(t)) return true;
  // 3) 绝对值/范数：|x|, \|v\|, |a-b|（成对竖线且内部有内容）
  if (/\|[^|]+\|/.test(t)) return true;
  // 4) 比较/关系链：a<b, x>=0, m != n, p \le q（含关系符且两侧有变量/数字）
  if (/[A-Za-z0-9)\]}]\s*(<=|>=|!=|<|>|=|≤|≥|≠)\s*[A-Za-z0-9(\\[{.-]/.test(t)) return true;
  // 5) 函数/导数记号：f(x), g'(x), \sin(x)（字母后紧跟括号，且整体不是纯英文句子）
  if (/[A-Za-z]'?\([A-Za-z0-9,\s|+\-*/^_]*\)/.test(t) && /['^_\\|]/.test(t)) return true;
  // 6) 带希腊/运算的算式：含 + - * / 且含变量或希腊字母
  if (/[+\-*/](?=[^\s])/.test(t) && /[A-Za-z\\]/.test(t) && /[0-9A-Za-z}]/.test(t) && t.length <= 40) {
    // 排除普通带连字符英文词（如 well-known）
    if (!/^[A-Za-z]+(-[A-Za-z]+)+$/.test(t)) return true;
  }
  return false;
}

/**
 * guessMath 预处理：在 markdown 源码里，把「明显是数学、但没被 $ 包住」的
 * 行内片段用 $…$ 包起来，交给正常的公式管线渲染。
 *
 * 规则（保守，避免误伤）：
 *  - 逐行处理，跳过代码围栏 ``` 内部与行内代码 `…`；
 *  - 已经在 $…$ / $$…$$ 里的不动；
 *  - 候选片段：连续的非空白“类公式”串——含 \命令 或 ^/_ 上下标，
 *    且不落在 URL / 纯英文单词里。命中则用 $ 包裹。
 */
export function preprocessGuessMath(src: string): string {
  const lines = src.split('\n');
  let inFence = false;
  let inMathBlock = false; // 处于多行 $$ … $$ 块内
  const out: string[] = [];

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // 统计本行未转义的 $$ 出现次数，用于跟踪块级公式的进出，
    // 避免把 $$ 块内部的行当普通文本又包一层 $（会产生非法 TeX 变红）。
    const dd = (line.match(/\$\$/g) || []).length;
    if (inMathBlock) {
      out.push(line); // 块内原样保留
      if (dd % 2 === 1) inMathBlock = false; // 本行含闭合 $$
      continue;
    }
    if (dd % 2 === 1) {
      // 本行开启一个跨行 $$ 块（如单独一行 "$$"）
      out.push(line);
      inMathBlock = true;
      continue;
    }
    // 表格行走专用分支：分隔行必须原样放过，否则表格降级成段落
    out.push(isTableLine(line) ? guessTableRow(line) : guessInline(line));
  }
  return out.join('\n');
}

/** 对单行做行内猜测包裹，跳过行内代码与已有 $ 公式区。 */
function guessInline(line: string): string {
  // 把行按「代码段 / 已有公式段 / 普通段」切分，只在普通段里做替换
  const segments: { text: string; protect: boolean }[] = [];
  const re = /(`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), protect: false });
    segments.push({ text: m[0], protect: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segments.push({ text: line.slice(last), protect: false });

  return segments
    .map((seg) => (seg.protect ? seg.text : wrapMathTokens(seg.text)))
    .join('');
}

/* ── 表格行的猜测渲染：先保结构，再在单元格里猜公式 ── */

/** 判断一行是不是表格行：分隔行 `|---|`，或首尾带竖线的数据行 `| a | b |` */
function isTableLine(line: string): boolean {
  const s = line.trim();
  if (!s.includes('|')) return false;
  if (DELIM_ROW.test(s)) return true;
  return s.startsWith('|') || s.endsWith('|');
}

/**
 * 表格行的猜测渲染。**分隔行必须原样放过**——一旦 `|---|---|` 被 looksLikeMath
 * 当成「绝对值/范数」包成 `$|---|---|$`，整张表就降级成段落（用户报「表格
 * 压根没渲染」的主因）。数据行则按单元格逐个猜测：既保住 `|` 结构，单元格
 * 里的裸公式照样能渲染。
 */
function guessTableRow(line: string): string {
  if (DELIM_ROW.test(line.trim())) return line;
  const { head, cells, tail } = splitTableRow(line);
  if (!cells.length) return line;
  // 含转义竖线 `\|` 的单元格是「合并回来的内容」，别再往里塞 $ —— 交给 KaTeX 会报错标红
  return head + cells.map((c) => (c.includes('\\|') ? c : guessInline(c))).join('|') + tail;
}

/** 按未转义的 `|` 切分表格行，保留首尾竖线与 `\|` 转义。 */
function splitTableRow(line: string): { head: string; cells: string[]; tail: string } {
  let i = 0;
  let head = '';
  if (line[i] === '|') {
    head = '|';
    i = 1;
  }
  const cells: string[] = [];
  let buf = '';
  let tail = '';
  while (i < line.length) {
    const c = line[i];
    // 转义竖线 `\|` 属于单元格内容，不参与切分
    if (c === '\\' && line[i + 1] === '|') {
      buf += '\\|';
      i += 2;
      continue;
    }
    // 末尾竖线（后面只剩空白）→ 收尾竖线，不是分隔符
    if (c === '|' && /^\s*$/.test(line.slice(i + 1))) {
      tail = line.slice(i);
      break;
    }
    if (c === '|') {
      cells.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  if (buf !== '' || cells.length === 0) cells.push(buf);
  return { head, cells, tail };
}

/**
 * 在普通文本段里，找出连续的「类公式」token 串并用 $…$ 包裹。
 * token 边界：空白与中文标点/中文字符。允许公式内包含 \ { } ^ _ | ( ) [ ] 数字字母
 * 与常见运算符 + - = < > / ~ 等。
 */
function wrapMathTokens(text: string): string {
  // 允许出现在“数学串”里的字符
  const mathChar = /[A-Za-z0-9\\{}\^_|()\[\].,;:+\-*/=<>~'"!]/;
  let res = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (mathChar.test(text[i])) {
      let j = i;
      let buf = '';
      while (j < n && (mathChar.test(text[j]) || /\s/.test(text[j]))) {
        // 允许公式内部含单个空格（如 a \sim b），但遇到两个连续空格或换行就停
        if (/\s/.test(text[j])) {
          // 向前看：空白后紧跟数学字符才并入，否则断开
          const k = j + 1;
          if (k < n && mathChar.test(text[k])) {
            buf += text[j];
            j++;
            continue;
          }
          break;
        }
        buf += text[j];
        j++;
      }
      const trimmed = buf.replace(/\s+$/, '');
      if (looksLikeMath(trimmed) && trimmed.length >= 2) {
        // 保留尾随空白到外面
        const tail = buf.slice(trimmed.length);
        res += `$${trimmed}$${tail}`;
      } else {
        res += buf;
      }
      i = j;
    } else {
      res += text[i];
      i++;
    }
  }
  return res;
}

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

export interface RenderOptions {
  /** 猜测渲染：把无分界符但明显是数学的片段自动当公式渲染（M4，用户设置） */
  guessMath?: boolean;
}

/**
 * 渲染 Markdown → { html, toc }。
 * 解析期一次遍历给标题打去重 slug 并收集目录，再渲染为 HTML。
 */
export function renderMarkdown(src: string, engine?: MD, opts?: RenderOptions): RenderResult {
  const md = engine ?? createEngine();
  // 始终先归一化 \(\) \[\] 定界符（修复公式标红不渲染）；再按需猜测渲染
  // 两步归一化，与 guessMath 无关、始终执行：
  // 先救数学定界符 \(\) \[\]，再救表格（分隔用了形近字符时整张表会降级成段落）
  const normalized = normalizeTablePipes(normalizeMathDelims(src));
  const source = opts?.guessMath ? preprocessGuessMath(normalized) : normalized;
  const env = {};
  const tokens = md.parse(source, env);
  const toc: TocItem[] = [];
  const used = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const level = Number(t.tag.slice(1)); // h2 -> 2
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    // 用 markdown-it 的 inline 渲染器把标题渲染成 HTML（含公式占位），
    // 供 TOC 一样能显示/排版公式；纯文本 text 保留给 slug/tooltip。
    const headHtml =
      inline && inline.type === 'inline'
        ? md.renderer.renderInline(inline.children ?? [], md.options, env)
        : escapeAttr(text);
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
    toc.push({ level, text, html: headHtml, slug });
  }

  const html = md.renderer.render(tokens, md.options, env);
  return { html, toc };
}




