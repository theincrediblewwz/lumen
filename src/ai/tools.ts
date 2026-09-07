/**
 * AI 白板工具（M5-3）：让 AI 能主动读取白板结构、节点文档、做检索，
 * 而不仅依赖打开时注入的 outline。采用 OpenAI 兼容的 function calling。
 *
 * 工具定义（JSON schema）是纯数据；执行器 executeTool 通过注入的 ToolContext
 * 访问白板与文档读取能力，因此可脱离 Tauri 单测。
 */

import type { BoardFile } from '../api';
import { buildBoardOutline, nodeLine, truncate } from './boardContext';

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 供工具执行使用的上下文（由调用方注入，含异步文档读取）。 */
export interface ToolContext {
  board: BoardFile;
  /** 读取某文档相对路径的正文（docs/xxx.md） */
  readDoc: (path: string) => Promise<string>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_board_outline',
      description: '获取当前白板的完整结构大纲：所有节点（含概括）与连线关系。当需要整体把握研究脉络时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_nodes',
      description: '列出白板上所有节点的 id、标题、概括与所含文档数，用于挑选要深入阅读的节点。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_node_doc',
      description: '读取某个节点关联文档的正文。传入节点 id；若该节点有多篇文档，可用 docIndex 指定第几篇（从 0 开始，默认 0）。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 id（形如 n_xxx）' },
          docIndex: { type: 'number', description: '第几篇文档，从 0 开始，默认 0' },
        },
        required: ['nodeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_board',
      description: '在白板的节点标题、概括以及文档正文中全文检索关键词，返回命中的节点与片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
        },
        required: ['query'],
      },
    },
  },
];

/** 找节点 */
function findNode(board: BoardFile, nodeId: string) {
  return board.nodes.find((n) => n.id === nodeId);
}

/** 执行一个工具调用，返回给模型看的文本结果。 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case 'read_board_outline':
      return buildBoardOutline(ctx.board);

    case 'list_nodes': {
      if (ctx.board.nodes.length === 0) return '（白板没有节点）';
      return ctx.board.nodes.map((n) => nodeLine(n)).join('\n');
    }

    case 'read_node_doc': {
      const nodeId = String(args.nodeId ?? '');
      const idx = Number.isFinite(Number(args.docIndex)) ? Number(args.docIndex) : 0;
      const node = findNode(ctx.board, nodeId);
      if (!node) return `未找到节点 ${nodeId}。可先调用 list_nodes 获取有效 id。`;
      if (!node.docs || node.docs.length === 0) return `节点「${node.title}」没有关联文档。`;
      if (idx < 0 || idx >= node.docs.length) {
        return `节点「${node.title}」只有 ${node.docs.length} 篇文档，docIndex ${idx} 越界。`;
      }
      const doc = node.docs[idx];
      try {
        const content = await ctx.readDoc(doc.path);
        return `# 节点「${node.title}」的文档《${doc.title}》\n\n${content}`;
      } catch (e) {
        return `读取文档失败：${String(e)}`;
      }
    }

    case 'search_board': {
      const q = String(args.query ?? '').trim();
      if (!q) return '检索词为空。';
      const ql = q.toLowerCase();
      const hits: string[] = [];
      for (const n of ctx.board.nodes) {
        const inTitle = n.title.toLowerCase().includes(ql);
        const inSummary = (n.summary ?? '').toLowerCase().includes(ql);
        let docHit = '';
        for (const d of n.docs ?? []) {
          try {
            const content = await ctx.readDoc(d.path);
            const pos = content.toLowerCase().indexOf(ql);
            if (pos !== -1) {
              const start = Math.max(0, pos - 40);
              const snippet = content.slice(start, pos + q.length + 60).replace(/\s+/g, ' ');
              docHit = `《${d.title}》…${truncate(snippet, 140)}…`;
              break;
            }
          } catch {
            /* 忽略读取失败的文档 */
          }
        }
        if (inTitle || inSummary || docHit) {
          const why = [
            inTitle ? '标题命中' : '',
            inSummary ? '概括命中' : '',
            docHit ? `文档命中: ${docHit}` : '',
          ]
            .filter(Boolean)
            .join('；');
          hits.push(`#${n.id} ${truncate(n.title, 40)} — ${why}`);
        }
      }
      if (hits.length === 0) return `没有找到与「${q}」相关的内容。`;
      return `检索「${q}」命中 ${hits.length} 个节点：\n` + hits.join('\n');
    }

    default:
      return `未知工具：${name}`;
  }
}
