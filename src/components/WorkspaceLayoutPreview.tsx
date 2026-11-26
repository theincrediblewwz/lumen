import { useId } from 'react';
import { layoutBounds, type LayoutPreview } from '../ai/workspaceLayout';
import { routeBoardEdges } from '../canvas/edgeRouting';
import { MarkdownView } from './MarkdownView';

const DENSITY = { compact: '紧凑', balanced: '适中', airy: '宽松' };
const DIRECTION = { auto: '按分支自适应', down: '从上到下', right: '从左到右' };

export function WorkspaceLayoutPreview({ layout }: { layout: LayoutPreview }) {
  const marker = useId();
  const bounds = layoutBounds(layout.nodes);
  const padding = 24;
  const labelSize = Math.min(48, Math.max(17, 12 * Math.max((bounds.w + 2 * padding) / 420, (bounds.h + 2 * padding) / 225)));
  const labelInset = Math.round(labelSize * .5);
  const routes = routeBoardEdges(new Map(layout.nodes.map(node => [node.id, node])), layout.edges);
  return (
    <figure className="workspace-layout-preview" aria-label={`布局预览 ${layout.name}`}>
      <figcaption><strong>{layout.name}</strong><small>{layout.nodes.length} 个节点 · {DIRECTION[layout.direction]} · {DENSITY[layout.spacing]}间距</small></figcaption>
      <svg viewBox={`${bounds.x - padding} ${bounds.y - padding} ${bounds.w + 2 * padding} ${bounds.h + 2 * padding}`} role="img" aria-label="节点位置与连线">
        <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0L7 3.5L0 7Z" fill="var(--text-secondary)"/></marker></defs>
        {layout.edges.map(edge => <path key={edge.id} d={routes.get(edge.id)?.d} className="workspace-layout-edge" markerEnd={edge.directed ? `url(#${marker})` : undefined}/>)}
        {layout.nodes.map(node => <g key={node.id} data-layout-node={node.id}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="11" fill="var(--bg-node)" stroke={node.color && /^#[\da-f]{6}$/i.test(node.color) ? node.color : 'var(--border-strong)'} strokeWidth="3"/>
          {node.w > 3 * labelInset && node.h > 2 * labelInset && <foreignObject x={node.x + labelInset} y={node.y + labelInset * .7} width={node.w - 2 * labelInset} height={node.h - labelInset}>
            <div style={{ fontSize: Math.min(labelSize, node.h / 2) }}><MarkdownView className="workspace-layout-label" inline value={node.title || '无标题节点'}/></div>
          </foreignObject>}
        </g>)}
      </svg>
      <p>{layout.reason}</p>
    </figure>
  );
}
