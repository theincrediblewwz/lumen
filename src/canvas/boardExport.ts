/**
 * 白板导出（M6-7）：纯函数，把白板导成 Markdown / HTML（保留层级）与 SVG。
 *
 * 层级来源：与自动布局同构——有向边 from→to 视为父→子，无向边由 BFS 认领，
 * 根 = 无入边节点。Markdown 用标题层级 + 缩进保留父子关系（验收要求）。
 */

import type { BoardFile, BoardNode, BoardEdge } from '../api';

interface TreeNode {
  node: BoardNode;
  depth: number;
  children: TreeNode[];
}

/** 由节点 + 连线构建有根森林（稳健处理环/森林/孤立点）。 */
export function buildForest(nodes: BoardNode[], edges: BoardEdge[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenIds = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    childrenIds.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  const uAdj = new Map<string, string[]>();
  for (const n of nodes) uAdj.set(n.id, []);
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    if (e.directed) {
      childrenIds.get(e.from)!.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    } else {
      uAdj.get(e.from)!.push(e.to);
      uAdj.get(e.to)!.push(e.from);
    }
  }

  const visited = new Set<string>();
  const makeNode = (id: string, depth: number): TreeNode => {
    visited.add(id);
    const kids: TreeNode[] = [];
    for (const c of [...childrenIds.get(id)!, ...uAdj.get(id)!]) {
      if (!visited.has(c)) kids.push(makeNode(c, depth + 1));
    }
    return { node: byId.get(id)!, depth, children: kids };
  };

  const roots: TreeNode[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0 && !visited.has(n.id)) {
      roots.push(makeNode(n.id, 0));
    }
  }
  // 补齐仍未访问（纯环 / 孤立）
  for (const n of nodes) {
    if (!visited.has(n.id)) roots.push(makeNode(n.id, 0));
  }
  return roots;
}

/** 导出为 Markdown：标题层级 + 缩进保留父子关系。 */
export function exportMarkdown(board: BoardFile): string {
  const out: string[] = [];
  out.push(`# ${board.name}`);
  out.push('');
  out.push(`> 导出自「脉络 Lumen」· 节点 ${board.nodes.length} · 连线 ${board.edges.length}`);
  out.push('');

  const walk = (t: TreeNode) => {
    const headingLevel = Math.min(t.depth + 2, 6); // h2 起，最深 h6
    const hashes = '#'.repeat(headingLevel);
    out.push(`${hashes} ${t.node.title}`);
    if (t.node.summary && t.node.summary.trim()) {
      out.push('');
      out.push(t.node.summary.trim());
    }
    if (t.node.docs && t.node.docs.length > 0) {
      out.push('');
      for (const d of t.node.docs) out.push(`- 📄 ${d.title}`);
    }
    out.push('');
    for (const c of t.children) walk(c);
  };

  const forest = buildForest(board.nodes, board.edges);
  if (forest.length === 0) out.push('_（空白板）_');
  for (const r of forest) walk(r);

  // 附：连线关系一览（含带标签的关系，避免层级化丢失的信息）
  if (board.edges.length > 0) {
    const titleOf = (id: string) => board.nodes.find((n) => n.id === id)?.title ?? '(已删除)';
    out.push('---');
    out.push('');
    out.push('## 关系一览');
    out.push('');
    for (const e of board.edges) {
      const arrow = e.directed ? '→' : '—';
      const label = e.label ? ` （${e.label}）` : '';
      out.push(`- ${titleOf(e.from)} ${arrow} ${titleOf(e.to)}${label}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 导出为独立 HTML（自带内联样式，可离线打开；保留层级为嵌套列表）。 */
export function exportHtml(board: BoardFile): string {
  const renderTree = (t: TreeNode): string => {
    const summary = t.node.summary?.trim()
      ? `<p class="summary">${escapeHtml(t.node.summary.trim())}</p>`
      : '';
    const docs =
      t.node.docs && t.node.docs.length
        ? `<ul class="docs">${t.node.docs.map((d) => `<li>📄 ${escapeHtml(d.title)}</li>`).join('')}</ul>`
        : '';
    const kids = t.children.length
      ? `<ul class="children">${t.children.map((c) => renderTree(c)).join('')}</ul>`
      : '';
    return `<li><div class="node"><span class="title">${escapeHtml(t.node.title)}</span>${summary}${docs}</div>${kids}</li>`;
  };
  const forest = buildForest(board.nodes, board.edges);
  const body = forest.length
    ? `<ul class="tree">${forest.map((r) => renderTree(r)).join('')}</ul>`
    : '<p class="empty">（空白板）</p>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(board.name)} — 脉络 Lumen</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    max-width:820px;margin:40px auto;padding:0 20px;color:#1c1e21;line-height:1.6;}
  h1{font-size:26px;border-bottom:2px solid #e3ede8;padding-bottom:10px;}
  .meta{color:#7a8b84;font-size:13px;margin-bottom:24px;}
  ul.tree,ul.children{list-style:none;padding-left:20px;border-left:1px solid #e3ede8;}
  ul.tree{padding-left:0;border-left:none;}
  li{margin:8px 0;}
  .node .title{font-weight:600;font-size:15px;}
  .summary{margin:4px 0 4px;color:#42524b;font-size:14px;}
  ul.docs{list-style:none;padding-left:0;margin:4px 0;}
  ul.docs li{color:#7a8b84;font-size:13px;}
  .empty{color:#9aa;}
  hr{border:none;border-top:1px solid #e3ede8;margin:28px 0;}
  h2{font-size:18px;}
  .rel{color:#42524b;font-size:14px;}
</style></head><body>
<h1>${escapeHtml(board.name)}</h1>
<div class="meta">导出自「脉络 Lumen」 · 节点 ${board.nodes.length} · 连线 ${board.edges.length}</div>
${body}
${
  board.edges.length
    ? `<hr><h2>关系一览</h2>${board.edges
        .map((e) => {
          const titleOf = (id: string) =>
            escapeHtml(board.nodes.find((n) => n.id === id)?.title ?? '(已删除)');
          const arrow = e.directed ? '→' : '—';
          const label = e.label ? `（${escapeHtml(e.label)}）` : '';
          return `<div class="rel">${titleOf(e.from)} ${arrow} ${titleOf(e.to)} ${label}</div>`;
        })
        .join('')}`
    : ''
}
</body></html>`;
}

/** 名义节点高度（导出 SVG 时用；DOM 真实高度不可得时的估算）。 */
const NODE_H = 64;

/** 导出为 SVG：按节点存储坐标绘制卡片 + 连线，自带主题色，独立可看。 */
export function exportSvg(
  board: BoardFile,
  opts: { bg?: string; nodeBg?: string; nodeBorder?: string; text?: string; edge?: string; accent?: string } = {},
): string {
  const bg = opts.bg ?? '#ffffff';
  const nodeBg = opts.nodeBg ?? '#ffffff';
  const nodeBorder = opts.nodeBorder ?? '#dcece4';
  const text = opts.text ?? '#1c1e21';
  const edge = opts.edge ?? '#b4bfba';
  const accent = opts.accent ?? '#2e5a4e';

  const nodes = board.nodes;
  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="${bg}"/><text x="200" y="100" text-anchor="middle" fill="${text}" font-family="sans-serif">空白板</text></svg>`;
  }
  const pad = 40;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + (n.w || 240)));
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const tx = (x: number) => x - minX + pad;
  const ty = (y: number) => y - minY + pad;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
  parts.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${edge}"/></marker></defs>`,
  );

  // 连线（node 中心到中心，简单直线；导出图用直线足够清晰）
  for (const e of board.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ax = tx(a.x + (a.w || 240) / 2);
    const ay = ty(a.y + NODE_H / 2);
    const bx = tx(b.x + (b.w || 240) / 2);
    const by = ty(b.y + NODE_H / 2);
    parts.push(
      `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${edge}" stroke-width="1.75"${e.directed ? ' marker-end="url(#arrow)"' : ''}/>`,
    );
    if (e.label) {
      parts.push(
        `<text x="${((ax + bx) / 2).toFixed(1)}" y="${((ay + by) / 2).toFixed(1)}" text-anchor="middle" fill="${text}" font-size="11" font-family="sans-serif">${escapeHtml(e.label)}</text>`,
      );
    }
  }

  // 节点卡片
  for (const n of nodes) {
    const x = tx(n.x);
    const y = ty(n.y);
    const nw = n.w || 240;
    const color = n.color || accent;
    parts.push(
      `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${nw}" height="${NODE_H}" rx="10" fill="${nodeBg}" stroke="${nodeBorder}" stroke-width="1"/>` +
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="4" height="${NODE_H}" rx="2" fill="${color}"/>` +
        `<text x="${(x + 16).toFixed(1)}" y="${(y + 26).toFixed(1)}" fill="${text}" font-size="14" font-weight="600" font-family="sans-serif">${escapeHtml(clip(n.title, 26))}</text>` +
        (n.summary
          ? `<text x="${(x + 16).toFixed(1)}" y="${(y + 46).toFixed(1)}" fill="${text}" font-size="11.5" opacity="0.7" font-family="sans-serif">${escapeHtml(clip(n.summary, 34))}</text>`
          : '') +
        `</g>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
