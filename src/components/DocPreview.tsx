import { useEffect, useRef, useState } from 'react';
import { api, type DocRef } from '../api';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';

/**
 * 关联文档预览卡（NodePanel 内）：把文档内容渲染成一个缩小的方块预览，
 * 一定程度上看到里面的内容。点击整卡打开阅读器；右上角可移除。
 *
 * 渲染真实 Markdown（含公式）后用 CSS transform 缩放塞进固定高度的方框，
 * 底部渐隐提示「还有更多」。内容按需拉取，带简单缓存避免重复读盘。
 */
const cache = new Map<string, string>();

export function DocPreview({
  doc,
  projectId,
  boardId,
  guessMath,
  onOpen,
  onRemove,
}: {
  doc: DocRef;
  projectId: string;
  boardId: string;
  guessMath: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const key = `${projectId}/${boardId}/${doc.path}::${guessMath}`;
  const [html, setHtml] = useState<string | null>(cache.get(key) ?? null);
  const [err, setErr] = useState(false);
  const scaleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (html != null) return;
    let alive = true;
    api
      .docRead(projectId, boardId, doc.path)
      .then((md) => {
        if (!alive) return;
        // 取开头一段做预览：字号正常、少显示几行也要看清内容
        const snippet = md.slice(0, 900);
        const { html: rendered } = renderMarkdown(snippet, undefined, { guessMath });
        cache.set(key, rendered);
        setHtml(rendered);
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [key, projectId, boardId, doc.path, guessMath, html]);

  useEffect(() => {
    if (html && scaleRef.current) {
      const handle = typesetMath(scaleRef.current, 40);
      return () => handle.cancel();
    }
  }, [html]);

  return (
    <div className="doc-card" title={`${doc.path}\n点击打开阅读`}>
      <button type="button" className="doc-card-remove" title="移除此文档" onClick={onRemove}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="doc-card-open" onClick={onOpen}>
        <div className="doc-card-thumb">
          {err ? (
            <div className="doc-card-fallback">无法预览</div>
          ) : html == null ? (
            <div className="doc-card-fallback">载入中…</div>
          ) : (
            <div
              ref={scaleRef}
              className="doc-card-scaled markdown-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          <div className="doc-card-fade" />
        </div>
        <div className="doc-card-foot">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span className="doc-card-title">{doc.title || doc.path}</span>
          {typeof doc.bytes === 'number' && (
            <span className="doc-card-bytes">{(doc.bytes / 1024).toFixed(1)} KB</span>
          )}
        </div>
      </button>
    </div>
  );
}

