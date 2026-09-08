import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../api';

/**
 * 全局搜索（M6-6）：跨全部项目 / 白板做全文检索（节点标题、简介、文档标题与正文）。
 * Ctrl/Cmd+K 打开；输入即搜（防抖）；点击结果跳到对应白板并高亮节点。
 */

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  node_title: '节点标题',
  node_summary: '节点简介',
  doc_title: '文档',
  doc_content: '文档正文',
};

/** 把 snippet 里命中的关键词高亮（大小写不敏感，纯文本安全） */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: Array<{ s: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      parts.push({ s: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ s: text.slice(i, idx), hit: false });
    parts.push({ s: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className="gs-mark">
            {p.s}
          </mark>
        ) : (
          <span key={k}>{p.s}</span>
        ),
      )}
    </>
  );
}

export function GlobalSearch({
  open,
  onClose,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  /** 跳到某白板并高亮节点（复用 App.jumpTo） */
  onJump: (projectId: string, boardId: string, nodeId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  // 打开时聚焦、清空上次
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 输入防抖检索
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await api.searchAll(q);
        setHits(res);
        setActiveIdx(0);
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const choose = useCallback(
    (h: SearchHit) => {
      onJump(h.projectId, h.boardId, h.nodeId);
      onClose();
    },
    [onJump, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[activeIdx]) {
      e.preventDefault();
      choose(hits[activeIdx]);
    }
  };

  if (!open) return null;

  return (
    <div className="gs-overlay" onClick={onClose}>
      <div
        className="gs-panel glass-surface"
        role="dialog"
        aria-label="全局搜索"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="gs-input-row">
          <svg className="gs-icon" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="gs-input"
            type="text"
            placeholder="搜索所有白板：节点、简介、文档正文…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="gs-kbd">Esc</kbd>
        </div>

        <div className="gs-results">
          {busy && <div className="gs-status">搜索中…</div>}
          {!busy && query.trim() && hits.length === 0 && (
            <div className="gs-status">没有找到「{query.trim()}」相关内容</div>
          )}
          {!busy && !query.trim() && (
            <div className="gs-status gs-hint">输入关键词，跨全部项目与白板检索。↑↓ 选择，Enter 打开。</div>
          )}
          {hits.map((h, i) => (
            <button
              type="button"
              key={`${h.boardId}-${h.nodeId}-${h.kind}-${i}`}
              className={`gs-item${i === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => choose(h)}
            >
              <div className="gs-item-top">
                <span className="gs-item-title">
                  <Highlighted text={h.title} query={query} />
                </span>
                <span className="gs-kind">{KIND_LABEL[h.kind]}</span>
              </div>
              <div className="gs-item-snippet">
                <Highlighted text={h.snippet} query={query} />
              </div>
              <div className="gs-item-crumb">
                {h.projectName} › {h.boardName}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
