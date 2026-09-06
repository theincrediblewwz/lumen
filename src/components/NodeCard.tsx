import { memo, useEffect, useRef } from 'react';
import type { BoardNode } from '../api';

/**
 * 节点卡片（M2-2）：圆角方框包裹问题标题，悬停看简介。
 * - 宽度由 node.w 决定（自适应内容在 CSS 里用 min/max-width 约束）；高度由文本撑开
 * - 不自己处理拖拽/缩放坐标换算，交给 BoardCanvas 的交互控制器（InteractionController）
 */
export const NodeCard = memo(function NodeCard({
  node,
  selected,
  editing,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
  onTitleCommit,
  onEditCancel,
}: {
  node: BoardNode;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onTitleCommit: (id: string, title: string) => void;
  onEditCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editing]);

  return (
    <div
      className={`node-card${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        borderLeftColor: node.color || undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onDoubleClick={() => onDoubleClick(node.id)}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      role="button"
      tabIndex={0}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          className="node-title-input"
          defaultValue={node.title}
          rows={1}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onTitleCommit(node.id, (e.target as HTMLTextAreaElement).value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onEditCancel();
            }
          }}
          onBlur={(e) => onTitleCommit(node.id, e.target.value)}
        />
      ) : (
        <div className="node-title">{node.title || '未命名问题'}</div>
      )}

      {node.summary && !editing && <div className="node-summary">{node.summary}</div>}

      {node.docs.length > 0 && !editing && (
        <div className="node-badge" title={`${node.docs.length} 篇文档`}>
          {node.docs.length} 篇
        </div>
      )}
    </div>
  );
});
