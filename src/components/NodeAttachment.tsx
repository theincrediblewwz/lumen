import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocRef } from '../api';
import { assetBytes, documentPayload } from '../documents/client';
import type { DocumentPayload } from '../documents/core';
import type { PDFDocumentProxy } from '../documents/pdf';
import { useDocumentImages } from '../documents/useDocumentImages';
import { renderRichMarkdown } from '../documents/render';
import { typesetMath } from '../reader/reader';
import { MarkdownView } from './MarkdownView';
import { StickerImage } from './StickerImage';
import { imageDoc } from '../canvas/composition';

const GAP = 24;
type PageProps = { page: number; onPages: (count: number) => void };
/** Only the current resource is loaded; source order and original bytes are untouched. */
export function NodeAttachment({ projectId, boardId, doc, refresh = 0, page = 0, onPages = () => {}, onImageSize }: {
  projectId: string; boardId: string; doc: DocRef; refresh?: number; page?: number;
  onPages?: (count: number) => void; onImageSize?: (size: { width: number; height: number }) => void;
}) {
  useEffect(() => { if (imageDoc(doc)) onPages(1); }, [doc.path, onPages]);
  if (imageDoc(doc)) return <div className="node-primary-image"><StickerImage projectId={projectId} boardId={boardId} path={doc.path} onSize={onImageSize}/></div>;
  return <DocumentOpening projectId={projectId} boardId={boardId} doc={doc} refresh={refresh} page={page} onPages={onPages}/>;
}
function DocumentOpening({ projectId, boardId, doc, refresh, page, onPages }: {
  projectId: string; boardId: string; doc: DocRef; refresh: number;
} & PageProps) {
  const [payload, setPayload] = useState<DocumentPayload>(), [error, setError] = useState('');
  useEffect(() => {
    let active = true; setPayload(undefined); setError('');
    void documentPayload(projectId, boardId, doc.path).then(p => active && setPayload(p)).catch(e => active && setError(String(e)));
    return () => { active = false; };
  }, [projectId, boardId, doc.path, doc.bytes, refresh]);
  const images = useDocumentImages(projectId, boardId, doc.path, payload?.attachment, payload?.scope);
  const html = useMemo(() => payload?.attachment?.kind === 'markdown_bundle' ? renderRichMarkdown(payload.markdown, payload.attachment, images.urls).html : undefined, [payload, images.urls]);
  if (error) return <div className="node-resource-error" data-content-status="error">文档暂时无法预览</div>;
  if (!payload) return <div className="node-resource-loading" data-content-status="loading">正在读取文档…</div>;
  if (payload.attachment?.kind === 'pdf') return <PdfPagePreview projectId={projectId} boardId={boardId} doc={doc} payload={payload} page={page} onPages={onPages}/>;
  const waiting = !!payload.attachment && Object.values(payload.attachment.images).some(a => !images.urls[a.path]) && !images.error;
  return <DocumentPages markdown={payload.markdown} html={html} page={page} onPages={onPages} waiting={waiting} error={images.error}/>;
}

/** Native column fragmentation preserves text, links, lists and formula markup across pages. */
export function DocumentPages({ markdown, html, page, onPages, waiting = false, error = '', question = false }: {
  markdown: string; html?: string; waiting?: boolean; error?: string; question?: boolean;
} & PageProps) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 0, height: 280, pages: 1 });
  useLayoutEffect(() => {
    if (content.current && html !== undefined) { const job = typesetMath(content.current, 24); return () => job.cancel(); }
  }, [html]);
  useLayoutEffect(() => {
    const view = viewport.current, inner = content.current; if (!view || !inner) return;
    let frame = 0, alive = true;
    const measure = () => {
      if (!alive || !view.clientWidth) return;
      const width = view.clientWidth, previous = inner.style.cssText;
      // Read the ordinary flow before fragmenting. Short notes stay compact, and
      // indivisible figures/formulas get enough height instead of being cropped.
      inner.style.cssText += `;column-count:auto;column-width:auto;height:auto;transform:none;width:${width}px`;
      const natural = Math.max(1, inner.scrollHeight);
      const atomic = Math.max(0, ...Array.from(inner.querySelectorAll<HTMLElement>('.math-block,.katex-display,img,tr')).map(el => el.offsetHeight));
      const height = Math.ceil(Math.max(Math.min(280, natural + 8), atomic + 8));
      inner.style.cssText = previous;
      inner.style.height = `${height}px`; inner.style.width = `${width}px`;
      // macOS WKWebView does not fragment column-count:1 without an explicit
      // column width, even though recent standalone WebKit does.
      inner.style.columnWidth = `${width}px`;
      // WKWebView can include an empty trailing column in scrollWidth. Count
      // the Markdown block's actual fragment positions so it never becomes a
      // blank extra page. Rectangles share the canvas transform/zoom.
      const origin = inner.getBoundingClientRect(), scale = origin.width / width || 1;
      const fragments = Array.from(inner.firstElementChild?.getClientRects() ?? []);
      const pages = Math.max(1, ...fragments.map(rect => 1 + Math.round((rect.left - origin.left) / ((width + GAP) * scale))));
      setLayout(old => old.width === width && old.height === height && old.pages === pages ? old : { width, height, pages });
      onPages(pages);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); resize.observe(view);
    const mutations = new MutationObserver(schedule); mutations.observe(inner, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-done', 'src'] });
    const appearance = new MutationObserver(schedule), board = view.closest('.board-canvas-live');
    if (board) appearance.observe(board, { attributes:true, attributeFilter:['style'] });
    inner.addEventListener('load', schedule, true); document.fonts.addEventListener('loadingdone', schedule); void document.fonts.ready.then(schedule); schedule();
    return () => { alive = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); appearance.disconnect(); inner.removeEventListener('load', schedule, true); document.fonts.removeEventListener('loadingdone', schedule); };
  }, [markdown, html, onPages]);
  const current = Math.min(page, layout.pages - 1);
  return <div ref={viewport} className={`node-document-opening node-page-viewport${question ? ' node-question' : ''}`} data-content-status={error ? 'error' : waiting || !layout.width ? 'loading' : 'ready'} style={{ height: layout.height }}>
    <div ref={content} className="node-page-columns" style={{ width: layout.width || undefined, columnWidth: layout.width || undefined, height: layout.height, transform: `translateX(${-current * (layout.width + GAP)}px)` }}>
      {html !== undefined ? <div className="markdown-body markdown-live" dangerouslySetInnerHTML={{ __html: html }} onClick={e => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); }}/>
        : <MarkdownView value={markdown}/>}
    </div>
    {error && <span className="node-resource-error">部分图片暂时无法读取</span>}
  </div>;
}

function PdfPagePreview({ projectId, boardId, doc, payload, page, onPages }: {
  projectId: string; boardId: string; doc: DocRef; payload: DocumentPayload;
} & PageProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState(''), [renderedPage, setRenderedPage] = useState<number>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true, task: ReturnType<typeof import('../documents/pdf')['loadPdf']> | undefined;
    void Promise.all([import('../documents/pdf'), assetBytes(projectId, boardId, doc.path, payload.attachment!.original, payload.scope)])
      .then(async ([module, bytes]) => { if (!alive) return; task = module.loadPdf(bytes); const value = await task.promise; if (alive) { setPdf(value); onPages(value.numPages); } })
      .catch(e => alive && setError(String(e)));
    return () => { alive = false; void task?.destroy(); };
  }, [projectId, boardId, doc.path, payload, onPages]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let alive = true, render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    void pdf.getPage(Math.min(page + 1, pdf.numPages)).then(async value => {
      if (!alive || !canvas.current) return;
      const base = value.getViewport({ scale: 1 }), viewport = value.getViewport({ scale: Math.min(2, 1200 / base.width) });
      const el = canvas.current; el.width = Math.ceil(viewport.width); el.height = Math.ceil(viewport.height);
      render = value.render({ canvas: el, canvasContext: el.getContext('2d')!, viewport });
      try { await render.promise; if (alive) setRenderedPage(page); } finally { value.cleanup(); }
    }).catch(e => alive && setError(String(e)));
    return () => { alive = false; render?.cancel(); };
  }, [pdf, page]);
  if (error) return <div className="node-resource-error" data-content-status="error">PDF 暂时无法预览，请在阅读器打开</div>;
  return <div className="node-pdf-page" data-content-status={renderedPage===page ? 'ready' : 'loading'}><canvas ref={canvas} aria-label={`PDF 第${page + 1}页`} style={{visibility:renderedPage===page?'visible':'hidden'}}/></div>;
}
