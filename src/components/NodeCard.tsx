import { memo, useEffect, useRef } from 'react';
import type { BoardNode } from '../api';

/** 自适应高度的文本域：随内容增减行数（修复长标题只显示尾部的问题） */
function AutoTextarea({
  value,
  placeholder,
  className,
  autoFocus,
  onCommit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  className: string;
  autoFocus?: boolean;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    grow();
    if (autoFocus) {
      const el = ref.current;
      el?.focus();
      el?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <textarea
      ref={ref}
      className={className}
      defaultValue={value}
      placeholder={placeholder}
      rows={1}
      onInput={grow}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !className.includes('node-q-input')) {
          e.preventDefault();
          onCommit((e.target as HTMLTextAreaElement).value);
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit((e.target as HTMLTextAreaElement).value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
}

/**
 * 节点卡片（M2-2 改版）：一个"问题"包含两种属性
 * - title：十几字的浓缩概括（大字）
 * - question(summary)：完整、具体的问题（正文，自动换行、框随字数增高）
 * 关联的 Markdown 文档不在卡面显示，点击节点后在气泡卡里查看。
 */
export const NodeCard = memo(function NodeCard({
  node,
  selected,
  editing,
  onPointerDown,
  onOpen,
  onStartEdit,
  onContextMenu,
  onCommit,
  onEditCancel,
}: {
  node: BoardNode;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onOpen: (id: string) => void;
  onStartEdit: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onCommit: (id: string, patch: { title?: string; summary?: string }) => void;
  onEditCancel: () => void;
}) {
  const docCount = node.docs.length;

  return (
    <div
      className={`node-card glass-surface${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        borderLeftColor: node.color || undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit(node.id);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (!editing) onOpen(node.id);
      }}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      role="button"
      tabIndex={0}
    >
      {editing ? (
        <div className="node-edit">
          <AutoTextarea
            className="node-title-input"
            value={node.title}
            placeholder="用十几个字概括这个问题…"
            autoFocus
            onCommit={(v) => onCommit(node.id, { title: v })}
            onCancel={onEditCancel}
          />
          <AutoTextarea
            className="node-q-input"
            value={node.summary ?? ''}
            placeholder="在这里写下完整、具体的问题（Shift/⌘+Enter 完成）"
            onCommit={(v) => onCommit(node.id, { summary: v })}
            onCancel={onEditCancel}
          />
        </div>
      ) : (
        <>
          <div className="node-title">{node.title || '未命名问题'}</div>
          {node.summary && <div className="node-question">{node.summary}</div>}
          {docCount > 0 && (
            <div className="node-badge" title={`${docCount} 篇文档`}>
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 2h5l3 3v9H4z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              {docCount}
            </div>
          )}
        </>
      )}
    </div>
  );
});
