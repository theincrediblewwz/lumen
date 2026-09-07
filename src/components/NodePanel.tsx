import { useEffect, useRef, useState } from 'react';
import type { BoardNode } from '../api';
import { DocPreview } from './DocPreview';

/** 可选的节点颜色标记（左边框色条），null = 默认（用主题强调色） */
const COLOR_SWATCHES: { id: string | null; label: string; color: string }[] = [
  { id: null, label: '默认', color: 'var(--accent)' },
  { id: '#e0503a', label: '红', color: '#e0503a' },
  { id: '#e08a2b', label: '橙', color: '#e08a2b' },
  { id: '#d4b106', label: '黄', color: '#d4b106' },
  { id: '#3a9d5d', label: '绿', color: '#3a9d5d' },
  { id: '#3b82c4', label: '蓝', color: '#3b82c4' },
  { id: '#8b5cf6', label: '紫', color: '#8b5cf6' },
];

/** 自适应高度文本域（面板内编辑用） */
function GrowArea({
  value,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  placeholder: string;
  className: string;
  onCommit: (v: string) => void;
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
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      rows={1}
      onInput={grow}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

/**
 * 节点内容面板（M2-7）：选中节点后停靠在画布右侧。
 * - 查看/编辑：概括标题、完整问题
 * - 颜色标记（左边框色条）
 * - 关联 Markdown 文档列表（导入在 M4）
 * - 删除节点
 */
export function NodePanel({
  node,
  onCommit,
  onColor,
  onDelete,
  onClose,
  onOpenDoc,
  onImportDocs,
  onRemoveDoc,
  projectId,
  boardId,
  guessMath = false,
}: {
  node: BoardNode;
  onCommit: (id: string, patch: { title?: string; summary?: string }) => void;
  onColor: (id: string, color: string | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  /** 打开某关联文档进入阅读器（M4-4） */
  onOpenDoc: (nodeId: string, path: string, title: string) => void;
  /** 导入 md 文档并关联到此节点（M4-3） */
  onImportDocs: (nodeId: string) => void;
  /** 从此节点解除某文档关联并删除文件 */
  onRemoveDoc: (nodeId: string, path: string) => void;
  /** 用于文档预览拉取内容 */
  projectId: string;
  boardId: string;
  guessMath?: boolean;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => setConfirmDel(false), [node.id]);

  const doImport = async () => {
    setImporting(true);
    try {
      await onImportDocs(node.id);
    } finally {
      setImporting(false);
    }
  };

  const docCount = node.docs.length;
  const updated = new Date(node.updated_at);
  const updatedStr = Number.isNaN(updated.getTime())
    ? ''
    : `${updated.getFullYear()}-${String(updated.getMonth() + 1).padStart(2, '0')}-${String(updated.getDate()).padStart(2, '0')} ${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`;

  return (
    <aside
      className="node-panel glass-surface"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="np-head">
        <span className="np-kicker">问题节点</span>
        <button type="button" className="np-close" title="收起面板 (Esc)" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="np-body">
        <div className="np-top">
        <label className="np-label">概括标题</label>
        <GrowArea
          className="np-title"
          value={node.title}
          placeholder="用十几个字概括这个问题…"
          onCommit={(v) => onCommit(node.id, { title: v })}
        />

        <label className="np-label">完整问题</label>
        <GrowArea
          className="np-question"
          value={node.summary ?? ''}
          placeholder="写下完整、具体的问题…"
          onCommit={(v) => onCommit(node.id, { summary: v })}
        />

        <label className="np-label">颜色标记</label>
        <div className="np-swatches">
          {COLOR_SWATCHES.map((s) => {
            const active = (node.color ?? null) === s.id;
            return (
              <button
                key={s.id ?? 'default'}
                type="button"
                className={`np-swatch${active ? ' is-active' : ''}`}
                title={s.label}
                style={{ background: s.color }}
                onClick={() => onColor(node.id, s.id)}
              >
                {active && (
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
        </div>

        <div className="np-docs-section">
        <label className="np-label">
          关联文档 {docCount > 0 && <span className="np-count">{docCount}</span>}
          <button
            type="button"
            className="np-doc-add"
            title="导入 Markdown 文档"
            disabled={importing}
            onClick={doImport}
          >
            {importing ? '导入中…' : '＋ 导入'}
          </button>
        </label>
        {docCount === 0 ? (
          <p className="np-empty">暂无关联文档。点「＋ 导入」选择 GPT 导出的 .md，或拖到节点上。</p>
        ) : (
          <div className="np-doc-grid">
            {node.docs.map((d) => (
              <DocPreview
                key={d.path}
                doc={d}
                projectId={projectId}
                boardId={boardId}
                guessMath={guessMath}
                onOpen={() => onOpenDoc(node.id, d.path, d.title || d.path)}
                onRemove={() => onRemoveDoc(node.id, d.path)}
              />
            ))}
          </div>
        )}
        </div>
      </div>

      <div className="np-foot">
        {updatedStr && <span className="np-updated">更新于 {updatedStr}</span>}
        {confirmDel ? (
          <span className="np-confirm">
            确定删除？
            <button type="button" className="np-del-yes" onClick={() => onDelete(node.id)}>删除</button>
            <button type="button" className="np-del-no" onClick={() => setConfirmDel(false)}>取消</button>
          </span>
        ) : (
          <button type="button" className="np-del" onClick={() => setConfirmDel(true)}>
            删除节点
          </button>
        )}
      </div>
    </aside>
  );
}




