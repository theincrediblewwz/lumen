import { useEffect, useRef, useState } from "react";
import {
  Download,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { assetBytes, exportDocument } from "../documents/client";
import { loadPdf, TextLayer, type PDFDocumentProxy } from "../documents/pdf";
import { readPdfTextContent } from "../documents/pdfText";
import { api } from "../api";
import type { DocumentPayload } from "../documents/core";
import { loadProgress, setProgress } from "../reader/readerPrefs";
export function PdfPage({
  pdf,
  page,
  scale = 1,
  thumbnail = false,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  scale?: number;
  thumbnail?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined,
      layer: TextLayer | undefined;
    const node = container.current;
    if (!node) return;
    const run = async () => {
      setError("");
      const documentPage = await pdf.getPage(page);
      try {
        if (stopped) return;
        const base = documentPage.getViewport({ scale: 1 });
        const width = thumbnail
          ? 600
          : Math.min(node.clientWidth - 32, 1100) * scale;
        const viewport = documentPage.getViewport({
          scale: Math.max(0.1, width / base.width),
        });
        const el = canvas.current;
        if (!el) return;
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
        );
        el.width = Math.ceil(viewport.width * ratio);
        el.height = Math.ceil(viewport.height * ratio);
        el.style.width = `${viewport.width}px`;
        el.style.height = `${viewport.height}px`;
        render = documentPage.render({
          canvas: el,
          canvasContext: el.getContext("2d")!,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await render.promise;
        if (stopped || thumbnail) return;
        const content = await readPdfTextContent(documentPage);
        if (stopped) return;
        const text = node.querySelector<HTMLDivElement>(".textLayer")!;
        text.innerHTML = "";
        text.style.width = `${viewport.width}px`;
        text.style.height = `${viewport.height}px`;
        text.style.setProperty("--total-scale-factor", String(viewport.scale));
        text.style.setProperty("--scale-round-x", "1px");
        text.style.setProperty("--scale-round-y", "1px");
        layer = new TextLayer({
          container: text,
          viewport,
          textContentSource: content,
        });
        await layer.render();
      } finally {
        documentPage.cleanup();
      }
    };
    void run().catch((e) => {
      if (!stopped) setError(`此页无法显示：${String(e)}`);
    });
    return () => {
      stopped = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, scale, thumbnail]);
  return (
    <div
      ref={container}
      className={thumbnail ? "pdf-page pdf-thumbnail" : "pdf-page"}
    >
      <div className="pdf-sheet">
        <canvas ref={canvas} />
        {!thumbnail && <div className="textLayer" />}
      </div>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
export default function PdfReader({
  payload,
  title,
  docKey,
  onClose,
  standalone = false,
  platform = "",
}: {
  payload: DocumentPayload;
  title: string;
  docKey: string;
  onClose?: () => void;
  standalone?: boolean;
  platform?: string;
}) {
  const [projectId, boardId, ...pathParts] = docKey.split("/"),
    path = pathParts.join("/");
  const [pdf, setPdf] = useState<PDFDocumentProxy>(),
    [page, setPage] = useState(1),
    [scale, setScale] = useState(1),
    [notice, setNotice] = useState("");
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    let alive = true;
    let task: ReturnType<typeof loadPdf> | undefined;
    void assetBytes(
      projectId,
      boardId,
      path,
      payload.attachment!.original,
      payload.scope,
    )
      .then(async (bytes) => {
        if (!alive) return;
        task = loadPdf(bytes);
        const loaded = await task.promise;
        if (!alive) return;
        setPdf(loaded);
        const ratio = await loadProgress(docKey);
        if (alive)
          setPage(
            Math.min(loaded.numPages, Math.floor(ratio * loaded.numPages) + 1),
          );
      })
      .catch((e) => alive && setNotice(String(e)));
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [docKey, payload, projectId, boardId, path]);
  const turn = (next: number) => {
    if (!pdf) return;
    const value = Math.max(1, Math.min(pdf.numPages, next));
    setPage(value);
    void setProgress(docKey, (value - 1) / pdf.numPages);
  };
  const close = () => {
    if (onClose) onClose();
    else
      void import("@tauri-apps/api/window").then((m) =>
        m.getCurrentWindow().close(),
      );
  };
  return (
    <div className="reader pdf-reader">
      <header
        className={`reader-bar${standalone ? " is-standalone-bar" : ""}${platform === "macos" && standalone ? " is-mac" : ""}`}
        data-tauri-drag-region
      >
        <h1 className="reader-title" data-tauri-drag-region title={title}>
          {title}
        </h1>
        <div className="reader-tools">
          <button
            className="reader-btn"
            title="导出 PDF 原件"
            onClick={() =>
              void exportDocument(projectId, boardId, path, title)
                .then((p) => p && setNotice(`已导出：${p}`))
                .catch((e) => setNotice(String(e)))
            }
          >
            <Download size={17} />
          </button>
          <button
            className="reader-btn"
            title="缩小页面"
            disabled={scale <= 0.5}
            onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
          >
            <Minus size={15} />
          </button>
          <span className="reader-font-val">{Math.round(scale * 100)}%</span>
          <button
            className="reader-btn"
            title="放大页面"
            disabled={scale >= 3}
            onClick={() => setScale((s) => Math.min(3, s + 0.25))}
          >
            <Plus size={15} />
          </button>
          <button
            className="reader-btn"
            title="上一页"
            disabled={page <= 1}
            onClick={() => turn(page - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <label className="pdf-page-control">
            <input
              aria-label="PDF 页码"
              type="number"
              min={1}
              max={pdf?.numPages ?? 1}
              value={page}
              onChange={(e) => turn(Number(e.target.value) || 1)}
            />
            <span>/ {pdf?.numPages ?? "…"}</span>
          </label>
          <button
            className="reader-btn"
            title="下一页"
            disabled={!pdf || page >= pdf.numPages}
            onClick={() => turn(page + 1)}
          >
            <ChevronRight size={17} />
          </button>
          <button className="reader-btn" title="关闭 PDF" onClick={close}>
            <X size={17} />
          </button>
        </div>
      </header>
      {notice && (
        <div className="document-notice" role="status">
          <p>{notice}</p>
          {!pdf && (
            <button
              className="btn"
              onClick={() =>
                void api
                  .docOpenExternal(
                    projectId,
                    boardId,
                    payload.attachment!.original.path,
                    payload.scope,
                  )
                  .catch((e) => setNotice(String(e)))
              }
            >
              用系统阅读器打开
            </button>
          )}
        </div>
      )}
      {payload.attachment?.extraction === "empty" && (
        <p className="document-notice">
          此 PDF 没有可检索文字；AI 暂时只能看到文件说明。
        </p>
      )}
      {payload.attachment?.extraction === "unavailable" && (
        <p className="document-notice">
          PDF 原件已保存，当前系统尚未提取文字；AI 暂时只能看到文件说明。
        </p>
      )}
      <div
        className="pdf-scroll"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") turn(page - 1);
          if (e.key === "ArrowRight") turn(page + 1);
        }}
        tabIndex={0}
      >
        {pdf ? (
          <PdfPage key={width} pdf={pdf} page={page} scale={scale} />
        ) : (
          <div className="reader-splash">
            {notice ? "请检查原件后重试" : "正在打开 PDF…"}
          </div>
        )}
      </div>
    </div>
  );
}
