import { describe, it, expect } from 'vitest';
import { buildForest, exportMarkdown, exportHtml, exportSvg } from './boardExport';
import type { BoardFile, BoardNode, BoardEdge } from '../api';

const node = (id: string, title: string, extra: Partial<BoardNode> = {}): BoardNode => ({
  id,
  title,
  summary: null,
  x: 0,
  y: 0,
  w: 240,
  color: null,
  docs: [],
  created_at: '',
  updated_at: '',
  ...extra,
});
const edge = (from: string, to: string, directed = true, label?: string): BoardEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  directed,
  label: label ?? null,
  created_at: '',
});
const board = (nodes: BoardNode[], edges: BoardEdge[]): BoardFile => ({
  version: 1,
  id: 'b1',
  name: '测试白板',
  projectId: 'p1',
  created_at: '',
  updated_at: '',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  edges,
});

describe('buildForest', () => {
  it('有向边构建父子层级', () => {
    const f = buildForest([node('a', 'A'), node('b', 'B')], [edge('a', 'b')]);
    expect(f).toHaveLength(1);
    expect(f[0].node.id).toBe('a');
    expect(f[0].children[0].node.id).toBe('b');
    expect(f[0].children[0].depth).toBe(1);
  });
  it('环不会死循环，所有节点被纳入', () => {
    const f = buildForest(
      [node('a', 'A'), node('b', 'B'), node('c', 'C')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    );
    const count = (ts: ReturnType<typeof buildForest>): number =>
      ts.reduce((s, t) => s + 1 + count(t.children), 0);
    expect(count(f)).toBe(3);
  });
  it('孤立节点成为根', () => {
    const f = buildForest([node('a', 'A'), node('x', 'X')], [edge('a', 'a')]);
    expect(f.map((t) => t.node.id).sort()).toEqual(['a', 'x']);
  });
});

describe('exportMarkdown', () => {
  it('保留层级：子节点标题级别更深', () => {
    const md = exportMarkdown(
      board([node('a', '根题'), node('b', '子题')], [edge('a', 'b')]),
    );
    expect(md).toContain('## 根题');
    expect(md).toContain('### 子题');
  });
  it('包含简介与文档', () => {
    const md = exportMarkdown(
      board(
        [node('a', '根', { summary: '一段简介', docs: [{ path: 'docs/x.md', title: 'X文档' }] })],
        [],
      ),
    );
    expect(md).toContain('一段简介');
    expect(md).toContain('X文档');
  });
  it('带标签连线进入关系一览', () => {
    const md = exportMarkdown(board([node('a', 'A'), node('b', 'B')], [edge('a', 'b', true, '导致')]));
    expect(md).toContain('关系一览');
    expect(md).toContain('（导致）');
  });
  it('空白板不报错', () => {
    expect(exportMarkdown(board([], []))).toContain('空白板');
  });
});

describe('exportHtml', () => {
  it('是完整 HTML 文档并转义', () => {
    const html = exportHtml(board([node('a', '<script>')], []));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('exportSvg', () => {
  it('生成 svg 且含节点标题', () => {
    const svg = exportSvg(board([node('a', '甲', { x: 10, y: 10 })], []));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('甲');
  });
  it('有向连线带箭头 marker', () => {
    const svg = exportSvg(
      board([node('a', 'A', { x: 0, y: 0 }), node('b', 'B', { x: 300, y: 0 })], [edge('a', 'b')]),
    );
    expect(svg).toContain('marker-end="url(#arrow)"');
  });
  it('空白板返回占位 svg', () => {
    expect(exportSvg(board([], []))).toContain('空白板');
  });
});
