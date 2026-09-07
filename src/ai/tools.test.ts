import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, executeTool, type ToolContext } from './tools';
import type { BoardFile, BoardNode } from '../api';

function mkNode(p: Partial<BoardNode> & { id: string; title: string }): BoardNode {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary ?? null,
    x: 0,
    y: 0,
    w: 200,
    color: null,
    docs: p.docs ?? [],
    created_at: '2026',
    updated_at: '2026',
  };
}

const board: BoardFile = {
  version: 1,
  id: 'b1',
  name: '丝绸之路',
  projectId: 'p1',
  created_at: '2026',
  updated_at: '2026',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    mkNode({ id: 'n1', title: '总览', summary: '路网与时间', docs: [{ path: 'docs/o.md', title: '总览' }] }),
    mkNode({ id: 'n2', title: '张骞', summary: '凿空西域' }),
  ],
  edges: [{ id: 'e1', from: 'n1', to: 'n2', directed: true, label: '如何开始', created_at: '2026' }],
};

const docs: Record<string, string> = {
  'docs/o.md': '# 总览\n丝绸之路运送的从来不只是丝绸，而是观念。造纸术由此西传。',
};

const ctx: ToolContext = {
  board,
  readDoc: async (p) => {
    if (p in docs) return docs[p];
    throw new Error('not found');
  },
};

describe('TOOL_DEFS', () => {
  it('定义了四个工具', () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    expect(names).toEqual(['read_board_outline', 'list_nodes', 'read_node_doc', 'search_board']);
  });
});

describe('executeTool', () => {
  it('read_board_outline 含节点与关系', async () => {
    const r = await executeTool('read_board_outline', {}, ctx);
    expect(r).toContain('#n1 总览');
    expect(r).toContain('→ #n2 张骞');
  });
  it('list_nodes 列出所有节点', async () => {
    const r = await executeTool('list_nodes', {}, ctx);
    expect(r).toContain('#n1 总览');
    expect(r).toContain('#n2 张骞');
  });
  it('read_node_doc 读取正文', async () => {
    const r = await executeTool('read_node_doc', { nodeId: 'n1' }, ctx);
    expect(r).toContain('造纸术由此西传');
  });
  it('read_node_doc 节点无文档时提示', async () => {
    const r = await executeTool('read_node_doc', { nodeId: 'n2' }, ctx);
    expect(r).toContain('没有关联文档');
  });
  it('read_node_doc 未知节点提示', async () => {
    const r = await executeTool('read_node_doc', { nodeId: 'nX' }, ctx);
    expect(r).toContain('未找到节点');
  });
  it('search_board 命中文档正文', async () => {
    const r = await executeTool('search_board', { query: '造纸术' }, ctx);
    expect(r).toContain('#n1');
    expect(r).toContain('文档命中');
  });
  it('search_board 命中标题', async () => {
    const r = await executeTool('search_board', { query: '张骞' }, ctx);
    expect(r).toContain('#n2');
  });
  it('search_board 无命中', async () => {
    const r = await executeTool('search_board', { query: '哈利波特' }, ctx);
    expect(r).toContain('没有找到');
  });
  it('未知工具', async () => {
    const r = await executeTool('nope', {}, ctx);
    expect(r).toContain('未知工具');
  });
});
