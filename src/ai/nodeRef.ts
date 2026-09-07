/**
 * 节点引用渲染（M5-6）。
 *
 * AI 在回答里用 `[[node:节点id]]` 引用白板节点。直接把这段文本交给 markdown-it，
 * id 里的下划线会被当成斜体/强调、`^`/`_` 会被数学插件吞掉，导致渲染成一堆糊状
 * 斜体乱码。因此像公式那样做「两级保护」：
 *   1. 渲染前：把 [[node:id]] 换成一个 markdown 绝不会改动的占位 token；
 *   2. 渲染后：把占位 token 换成显示「节点标题」的可点击胶囊 HTML。
 *
 * 胶囊显示节点**标题**（而非 id 代号），带 data-node-id 供点击跳转。
 */

const NODE_REF_RE = /\[\[node:([A-Za-z0-9_-]+)\]\]/g;
// 占位 token：用纯字母数字，markdown-it / KaTeX 都不会改动它
const TOKEN_PREFIX = 'LUMENNODEREF';

/** HTML 属性/文本转义 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 渲染前：把 [[node:id]] 替换成占位 token，返回替换后的文本与 id 顺序表。
 * token 形如 `LUMENNODEREF0X`（前后加零宽无关字符避免被 linkify）。
 */
export function maskNodeRefs(src: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const text = src.replace(NODE_REF_RE, (_m, id: string) => {
    const idx = ids.length;
    ids.push(id);
    return `${TOKEN_PREFIX}${idx}X`;
  });
  return { text, ids };
}

/**
 * 渲染后：把 HTML 里的占位 token 换成节点胶囊。titleOf 把 id 映射到标题；
 * 未知 id 显示「未知节点」但仍可点击（跳转时提示）。
 */
export function unmaskNodeRefs(html: string, ids: string[], titleOf: (id: string) => string | null): string {
  let out = html;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const title = titleOf(id);
    const label = title ?? '未知节点';
    const cls = title ? 'node-ref' : 'node-ref is-missing';
    const chip =
      `<a class="${cls}" data-node-id="${esc(id)}" title="${esc(title ? '跳转到：' + title : '未找到该节点')}" role="button">` +
      `<svg class="node-ref-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">` +
      `<rect x="2" y="3.5" width="12" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M5 7h6M5 9.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>` +
      `</svg>` +
      `<span class="node-ref-label">${esc(label)}</span></a>`;
    // 全局替换所有出现（同一引用可能出现多次）
    out = out.split(`${TOKEN_PREFIX}${i}X`).join(chip);
  }
  return out;
}
