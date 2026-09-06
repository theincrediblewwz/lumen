import { memo, useEffect, useLayoutEffect, useRef } from 'react';
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

/** 四个边缘中点锚点：按下即开始拉连线（M3-1） */
const ANCHORS: { side: string; cx: string; cy: string }[] = [
  { side: 'top', cx: '50%', cy: '0%' },
  { side: 'right', cx: '100%', cy: '50%' },
  { side: 'bottom', cx: '50%', cy: '100%' },
  { side: 'left', cx: '0%', cy: '50%' },
];

export const NodeCard = memo(function NodeCard({
  node,
  selected,
  editing,
  showAnchors,
  connectTarget,
  onPointerDown,
  onAnchorPointerDown,
  onOpen,
  onStartEdit,
  onContextMenu,
  onCommit,
  onEditCancel,
  onMeasure,
  onHoverChange,
}: {
  node: BoardNode;
  selected: boolean;
  editing: boolean;
  showAnchors: boolean;
  connectTarget: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onAnchorPointerDown: (e: React.PointerEvent, id: string) => void;
  onOpen: (id: string) => void;
  onStartEdit: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onCommit: (id: string, patch: { title?: string; summary?: string }) => void;
  onEditCancel: () => void;
  onMeasure: (id: string, w: number, h: number) => void;
  onHoverChange: (hovering: boolean) => void;
}) {
  const docCount = node.docs.length;
  const cardRef = useRef<HTMLDivElement>(null);

  // 测量真实布局尺寸（世界单位，不受 transform 缩放影响：offsetWidth/Height）
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => onMeasure(node.id, el.offsetWidth, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [node.id, node.title, node.summary, editing, onMeasure]);

  return (
    <div
      ref={cardRef}
      className={`node-card glass-surface${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}${connectTarget ? ' is-connect-target' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        borderLeftColor: node.color || undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
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
                <path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              {docCount}
            </div>
          )}
        </>
      )}

      {/* 连线锚点（选中/悬停时出现，按下即拉线） */}
      {showAnchors && !editing && (
        <div className="node-anchors" aria-hidden="true">
          {ANCHORS.map((a) => (
            <span
              key={a.side}
              className={`node-anchor anchor-${a.side}`}
              style={{ left: a.cx, top: a.cy }}
              title="拖到另一个节点建立连线"
              onPointerDown={(e) => onAnchorPointerDown(e, node.id)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ))}
        </div>
      )}
    </div>
  );
});
