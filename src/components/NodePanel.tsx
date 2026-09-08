import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

  /* ── 面板位置与尺寸（可拖动 + 可四边/四角拉伸），持久化到 localStorage ── */
  const asideRef = useRef<HTMLElement>(null);
  const MIN_W = 280;
  const MIN_H = 240;
  const RECT_KEY = 'lumen.nodePanel.rect.v1';
  type Rect = { left: number; top: number; width: number; height: number };
  const [rect, setRect] = useState<Rect | null>(() => {
    try {
      const raw = localStorage.getItem(RECT_KEY);
      return raw ? (JSON.parse(raw) as Rect) : null;
    } catch {
      return null;
    }
  });

  /** 夹紧到可视区内。
   *  坐标系统一为「视口坐标」：与 getBoundingClientRect() 同口径，配合
   *  .is-floating 的 position:fixed，写进 style 的 left/top 就是最终位置，
   *  无需再叠加画布容器的偏移（ADR-041）。 */
  function clamp(r: Rect): Rect {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.round(Math.min(Math.max(r.width, MIN_W), vw - 16));
    const height = Math.round(Math.min(Math.max(r.height, MIN_H), vh - 16));
    const left = Math.round(Math.min(Math.max(r.left, 8), Math.max(8, vw - width - 8)));
    const top = Math.round(Math.min(Math.max(r.top, 8), Math.max(8, vh - height - 8)));
    return { left, top, width, height };
  }

  // 首次挂载（或双击标题栏复位后）：以默认停靠位（画布右侧）初始化为具体像素，方便后续拖拽。
  // 依赖里带 rect：rect 被置回 null 时会重新量一次，用于「复位到默认位置」。
  useLayoutEffect(() => {
    if (rect || !asideRef.current) return;
    const r = asideRef.current.getBoundingClientRect();
    setRect(clamp({ left: r.left, top: r.top, width: r.width, height: r.height }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect]);

  // 保存位置，下次打开面板时恢复。
  useEffect(() => {
    if (!rect) return;
    try {
      localStorage.setItem(RECT_KEY, JSON.stringify(rect));
    } catch {
      /* 忽略 */
    }
  }, [rect]);

  // 窗口尺寸变化（含侧栏展开挤压可视区、外接显示器切换）时重新夹紧，避免面板被挤出屏幕。
  useEffect(() => {
    const onResize = () => setRect((prev) => (prev ? clamp(prev) : prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** 双击标题栏：复位到默认停靠位（位置记错 / 被挤出屏幕时的逃生口） */
  const resetDock = () => {
    try {
      localStorage.removeItem(RECT_KEY);
    } catch {
      /* 忽略 */
    }
    setRect(null);
  };

  // 拖动标题栏移动整个面板。
  // base 取自 getBoundingClientRect()（视口坐标），与 .is-floating(fixed) 下
  // style.left/top 的口径一致，所以起拖瞬间不会再跳位。
  const startMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // 关闭按钮等不触发拖动
    e.preventDefault();
    const base = asideRef.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: base.left, top: base.top };
    const onMove = (ev: PointerEvent) => {
      setRect((prev) =>
        clamp({
          left: start.left + (ev.clientX - start.x),
          top: start.top + (ev.clientY - start.y),
          width: prev?.width ?? base.width,
          height: prev?.height ?? base.height,
        }),
      );
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 从某条边/角开始拉伸；dir 含 n/s/e/w 任意组合
  const startResize = (dir: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const base = asideRef.current!.getBoundingClientRect();
    const start = {
      x: e.clientX,
      y: e.clientY,
      left: base.left,
      top: base.top,
      width: base.width,
      height: base.height,
    };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { left, top, width, height } = start;
      if (dir.includes('e')) width = start.width + dx;
      if (dir.includes('s')) height = start.height + dy;
      if (dir.includes('w')) {
        width = start.width - dx;
        left = start.left + dx;
      }
      if (dir.includes('n')) {
        height = start.height - dy;
        top = start.top + dy;
      }
      // 触底最小值时锁住对应边，避免继续拖时位置漂移
      if (width < MIN_W) {
        if (dir.includes('w')) left = start.left + (start.width - MIN_W);
        width = MIN_W;
      }
      if (height < MIN_H) {
        if (dir.includes('n')) top = start.top + (start.height - MIN_H);
        height = MIN_H;
      }
      setRect(clamp({ left, top, width, height }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const rectStyle: React.CSSProperties | undefined = rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: 'auto', bottom: 'auto' }
    : undefined;

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
      ref={asideRef}
      className={`node-panel glass-surface${rect ? ' is-floating' : ''}`}
      style={rectStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* 四边 + 四角拉伸手柄：按住哪条边往哪拖，就往哪个方向扩展 */}
      <span className="np-resize np-resize-n" onPointerDown={startResize('n')} />
      <span className="np-resize np-resize-s" onPointerDown={startResize('s')} />
      <span className="np-resize np-resize-e" onPointerDown={startResize('e')} />
      <span className="np-resize np-resize-w" onPointerDown={startResize('w')} />
      <span className="np-resize np-resize-ne" onPointerDown={startResize('ne')} />
      <span className="np-resize np-resize-nw" onPointerDown={startResize('nw')} />
      <span className="np-resize np-resize-se" onPointerDown={startResize('se')} />
      <span className="np-resize np-resize-sw" onPointerDown={startResize('sw')} />

      <div
        className="np-head"
        onPointerDown={startMove}
        onDoubleClick={resetDock}
        title="按住此处拖动面板 · 双击复位到默认位置"
      >
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





