import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardNode } from '../api';

/**
 * 节点气泡卡：点击节点后在其附近浮出，显示
 * - 概括标题
 * - 完整问题（保留换行）
 * - 关联的 Markdown 文档列表
 * 点击外部 / Esc 关闭。定位后按实际尺寸夹进视口，避免溢出。
 */
export function NodeBubble({
  node,
  anchor,
  onClose,
  onEdit,
}: {
  node: BoardNode;
  anchor: { x: number; y: number };
  onClose: () => void;
  onEdit: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y, ready: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 12;
    const { width, height } = el.getBoundingClientRect();
    let x = anchor.x + 16;
    let y = anchor.y;
    if (x + width + pad > window.innerWidth) x = anchor.x - width - 16;
    x = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
    y = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
    setPos({ x, y, ready: true });
  }, [anchor, node.id]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="node-bubble glass-surface"
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bubble-head">
        <h3 className="bubble-title">{node.title || '未命名问题'}</h3>
        <button type="button" className="bubble-edit" title="编辑" onClick={() => onEdit(node.id)}>
          编辑
        </button>
      </div>

      {node.summary ? (
        <p className="bubble-question">{node.summary}</p>
      ) : (
        <p className="bubble-empty">还没有填写完整问题。</p>
      )}

      <div className="bubble-docs">
        <div className="bubble-docs-head">
          Markdown 文档 {node.docs.length > 0 && <span className="bubble-count">{node.docs.length}</span>}
        </div>
        {node.docs.length === 0 ? (
          <p className="bubble-empty">暂无关联文档。（后续可从 GPT 导出的 .md 拖入此处）</p>
        ) : (
          <ul className="doc-list">
            {node.docs.map((d) => (
              <li key={d.path} className="doc-item" title={d.path}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                <span className="doc-title">{d.title || d.path}</span>
                {typeof d.bytes === 'number' && (
                  <span className="doc-bytes">{(d.bytes / 1024).toFixed(1)} KB</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
