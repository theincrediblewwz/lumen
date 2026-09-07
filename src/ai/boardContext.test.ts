import { describe, it, expect } from 'vitest';
import {
  truncate,
  nodeLine,
  buildBoardOutline,
  estimateTokens,
  buildSystemPrompt,
} from './boardContext';
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
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

const board: BoardFile = {
  version: 1,
  id: 'b1',
  name: '测试白板',
  projectId: 'p1',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    mkNode({ id: 'n1', title: '根问题', summary: '整体研究目标' }),
    mkNode({
      id: 'n2',
      title: '子问题A',
      docs: [{ path: 'a.md', title: 'A' }],
    }),
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', directed: true, label: '拆解', created_at: '2026' },
  ],
};

describe('truncate', () => {
  it('短文本原样、长文本加省略号', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
  it('压缩空白', () => {
    expect(truncate('a   b\n c', 20)).toBe('a b c');
  });
});

describe('nodeLine', () => {
  it('含 id/标题/概括/文档数', () => {
    const line = nodeLine(board.nodes[0]);
    expect(line).toContain('#n1');
    expect(line).toContain('根问题');
    expect(line).toContain('整体研究目标');
  });
  it('有文档标注篇数', () => {
    expect(nodeLine(board.nodes[1])).toContain('[1篇文档]');
  });
});

describe('buildBoardOutline', () => {
  it('包含节点与关系', () => {
    const o = buildBoardOutline(board);
    expect(o).toContain('# 白板：测试白板');
    expect(o).toContain('节点数 2，连线数 1');
    expect(o).toContain('#n1 根问题');
    expect(o).toContain('#n1 根问题 → #n2 子问题A (拆解)');
  });
  it('空白板给占位', () => {
    const empty = { ...board, nodes: [], edges: [] };
    const o = buildBoardOutline(empty);
    expect(o).toContain('（空）');
    expect(o).toContain('（无连线）');
  });
});

describe('estimateTokens', () => {
  it('中文按字数量级', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('英文约每4字符1token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

describe('buildSystemPrompt', () => {
  it('共享时含大纲', () => {
    const p = buildSystemPrompt(buildBoardOutline(board), true);
    expect(p).toContain('当前白板的结构');
    expect(p).toContain('#n1 根问题');
  });
  it('关闭共享时不含大纲', () => {
    const p = buildSystemPrompt(buildBoardOutline(board), false);
    expect(p).toContain('普通对话');
    expect(p).not.toContain('#n1 根问题');
  });
});
