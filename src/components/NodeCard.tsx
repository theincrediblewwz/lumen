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
  const skipCommit = useRef(false); // Escape 取消时跳过随之而来的 blur 提交
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
          skipCommit.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (skipCommit.current) {
          skipCommit.current = false;
          return;
        }
        onCommit(e.target.value);
      }}
    />
  );
}

/** 单个连线手柄：放在节点右侧中点，按下即开始拉连线（连线几何本就从节点中心
    朝目标算、吸附到边框，故一个手柄足矣，四个是冗余）。 */

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
  onExitEdit,
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
  onExitEdit: () => void;
  onMeasure: (id: string, w: number, h: number) => void;
  onHoverChange: (hovering: boolean, clientX: number, clientY: number) => void;
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
      onPointerEnter={(e) => onHoverChange(true, e.clientX, e.clientY)}
      onPointerLeave={(e) => onHoverChange(false, e.clientX, e.clientY)}
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
        <div
          className="node-edit"
          /* 焦点移出整个编辑区（点空白 / 点别的节点 / 点别处）→ 退出编辑模式。
             各字段各自的 onBlur 已提交内容，这里只负责关闭编辑态。
             relatedTarget 仍在编辑区内（如从标题切到问题框）则不退出。 */
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              onExitEdit();
            }
          }}
        >
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
          <div className="node-edit-hint">Enter 完成标题 · Esc 退出 · 点击别处保存并退出</div>
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

      {/* 连线手柄（选中/悬停时出现，按下即拉线）：节点右侧中点，单个 */}
      {showAnchors && !editing && (
        <div className="node-anchors" aria-hidden="true">
          <span
            className="node-anchor anchor-right"
            style={{ left: '100%', top: '50%' }}
            title="拖到另一个节点建立连线"
            onPointerDown={(e) => onAnchorPointerDown(e, node.id)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
});


