import { createPortal } from 'react-dom';
import type { BoardNode } from '../api';

/**
 * 节点悬停简介（M2-6）：悬停约 400ms 后在鼠标附近浮出的轻量提示。
 * 只读、不拦截指针；显示标题 + 完整问题的前若干行预览。
 */
export function NodeTooltip({ node, x, y }: { node: BoardNode; x: number; y: number }) {
  const pad = 14;
  const left = Math.min(x + 16, window.innerWidth - 320);
  const top = Math.min(y + 16, window.innerHeight - 120);
  return createPortal(
    <div
      className="node-tooltip glass-surface"
      style={{ left: Math.max(pad, left), top: Math.max(pad, top) }}
    >
      <div className="tt-title">{node.title || '未命名问题'}</div>
      {node.summary ? (
        <div className="tt-question">{node.summary}</div>
      ) : (
        <div className="tt-empty">（还没有完整问题）</div>
      )}
      {node.docs.length > 0 && <div className="tt-docs">📄 {node.docs.length} 篇关联文档</div>}
    </div>,
    document.body,
  );
}
