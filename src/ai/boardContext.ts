/**
 * 白板上下文构造（M5-3 / M5-4 纯逻辑）
 *
 * 把当前白板的结构（节点 + 连线）压成紧凑的大纲文本，供 AI 作为系统上下文。
 * 采用 outline-first 策略：先给结构与标题，文档正文按需再取（read_node_doc），
 * 以控制 token（应对 R-3 长白板上下文超限）。此处只做纯转换，便于单测。
 */

import type { BoardFile, BoardNode, BoardEdge } from '../api';

/** 截断长文本，保留可读前缀 */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** 单个节点的一行摘要：#id 标题 —— 概括（含文档数） */
export function nodeLine(n: BoardNode): string {
  const summary = n.summary ? ` —— ${truncate(n.summary, 60)}` : '';
  const docs = n.docs.length > 0 ? ` [${n.docs.length}篇文档]` : '';
  return `#${n.id} ${truncate(n.title, 40)}${summary}${docs}`;
}

/** 连线一行：from →/— to (标签) */
export function edgeLine(e: BoardEdge, titleOf: (id: string) => string): string {
  const arrow = e.directed ? '→' : '—';
  const label = e.label ? ` (${truncate(e.label, 30)})` : '';
  return `#${e.from} ${titleOf(e.from)} ${arrow} #${e.to} ${titleOf(e.to)}${label}`;
}

/** 生成整块白板大纲（节点清单 + 连线关系）。 */
export function buildBoardOutline(board: BoardFile): string {
  const titleOf = (id: string) => {
    const n = board.nodes.find((x) => x.id === id);
    return n ? truncate(n.title, 40) : '(已删除)';
  };
  const lines: string[] = [];
  lines.push(`# 白板：${board.name}`);
  lines.push(`节点数 ${board.nodes.length}，连线数 ${board.edges.length}`);
  lines.push('');
  lines.push('## 节点');
  if (board.nodes.length === 0) lines.push('（空）');
  for (const n of board.nodes) lines.push('- ' + nodeLine(n));
  lines.push('');
  lines.push('## 关系');
  if (board.edges.length === 0) lines.push('（无连线）');
  for (const e of board.edges) lines.push('- ' + edgeLine(e, titleOf));
  return lines.join('\n');
}

/** 极简 token 估算：中文按 1 字≈1 token、英文按 ~4 字符≈1 token，取偏大者近似。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/** 组装系统提示词：角色设定 + 白板大纲（受 shareBoard 与预算约束）。 */
export function buildSystemPrompt(outline: string, shareBoard: boolean): string {
  const role =
    '你是「脉络 Lumen」里的研究助手。用户在一块白板上用节点和连线整理一个研究问题的脉络。' +
    '请基于白板结构作答，回答用简体中文、条理清晰，可用 Markdown 与 KaTeX 公式。' +
    '引用某个节点时用 [[node:节点id]] 形式，便于跳转。';
  if (!shareBoard) return role + '\n\n（用户已关闭白板共享，仅进行普通对话。）';
  return `${role}\n\n以下是当前白板的结构：\n\n${outline}`;
}
