import { useEffect, useRef, useState } from 'react';
import { exportMarkdown } from '../ai/boardOperations';
import { Download } from 'lucide-react';
import { type DocRef } from '../api';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';
import { generatedDocument } from '../reader/documentPolicy';
import {documentPayload,exportDocument} from '../documents/client';
import type {DocumentMetadata} from '../documents/core';
import {useDocumentImages} from '../documents/useDocumentImages';
import {renderRichMarkdown} from '../documents/render';

/**
 * 关联文档预览卡（NodePanel 内）：把文档内容渲染成一个缩小的方块预览，
 * 一定程度上看到里面的内容。点击整卡打开阅读器；右上角可移除。
 *
 * 渲染真实 Markdown（含公式）后用 CSS transform 缩放塞进固定高度的方框，
 * 底部渐隐提示「还有更多」。内容按需拉取，带简单缓存避免重复读盘。
 */


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
  const key = `${projectId}/${boardId}/${doc.path}::${doc.bytes}::${guessMath}`;
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [exportStatus,setExportStatus]=useState('');
  const scaleRef = useRef<HTMLDivElement>(null);
  const[attachment,setAttachment]=useState<DocumentMetadata|null>(null),[markdown,setMarkdown]=useState(''),[scope,setScope]=useState<string>();
  const images=useDocumentImages(projectId,boardId,doc.path,attachment,scope);

  useEffect(() => {
    setHtml(null);setErr(false);
    let alive = true;
    documentPayload(projectId, boardId, doc.path)
      .then((payload) => {
        if (!alive) return;
        setAttachment(payload.attachment);setMarkdown(payload.markdown);setScope(payload.scope);
        // 取开头一段做预览：字号正常、少显示几行也要看清内容
        const snippet = payload.markdown;
        const { html: rendered } = renderMarkdown(snippet, undefined, { guessMath:guessMath&&!generatedDocument(doc.path) });

        setHtml(rendered);
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [key, projectId, boardId, doc.path, guessMath]);
  useEffect(()=>{if(attachment?.kind==='markdown_bundle')setHtml(renderRichMarkdown(markdown,attachment,images.urls).html);},[attachment,markdown,images.urls]);

  useEffect(() => {
    if (html && scaleRef.current) {
      const handle = typesetMath(scaleRef.current, 40);
      return () => handle.cancel();
    }
  }, [html]);

  return (
    <div className="doc-card" title={`${doc.path}\n点击打开阅读`}>
      { /\.(?:md|markdown)$/i.test(doc.path) && <button type="button" className="doc-card-export" aria-label={`导出 Markdown：${doc.title}`} title={attachment?.kind==='pdf'?'导出 PDF 原件':attachment?'导出 Markdown 与图片包':'导出 Markdown'} onClick={()=>void (attachment?exportDocument(projectId,boardId,doc.path,doc.title):exportMarkdown(projectId,boardId,doc.path,doc.title)).then(p=>p&&setExportStatus(`已导出：${p}`)).catch(e=>setExportStatus(String(e)))}><Download size={13}/></button>}
      {exportStatus&&<span className="doc-export-status" role="status">{exportStatus}</span>}
      <button type="button" className="doc-card-remove" title="移除此文档" onClick={onRemove}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="doc-card-open" onClick={onOpen}>
        <div className="doc-card-thumb">
          {attachment?.kind==='pdf'?<div className="doc-card-pdf"><span>PDF</span><p>{attachment.pages} 页 · {attachment.extraction==='ready'?'可检索文字':'原始页面'}</p></div>:err ? (
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
          <span className="doc-card-title">{doc.title || doc.path}{attachment?.kind==='markdown_bundle'?' · 图文':''}</span>
          {typeof doc.bytes === 'number' && (
            <span className="doc-card-bytes">{(doc.bytes / 1024).toFixed(1)} KB</span>
          )}
        </div>
      </button>
    </div>
  );
}
