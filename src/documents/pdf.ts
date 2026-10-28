// The worker, CMaps, fonts and codecs ship with the app; no CDN or PDF uploads.
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { readPdfTextContent } from "./pdfText";
GlobalWorkerOptions.workerSrc = workerUrl;
export { TextLayer };
export type { PDFDocumentProxy };
export function loadPdf(bytes: Uint8Array) {
  return getDocument({
    data: bytes.slice(),
    enableXfa: false,
    maxImageSize: 32_000_000,
    canvasMaxAreaInBytes: 64_000_000,
    cMapUrl: "/pdf-resources/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf-resources/standard_fonts/",
    wasmUrl: "/pdf-resources/wasm/",
    useWasm: true,
  });
}
export async function extractPdf(
  bytes: Uint8Array,
  progress: (text: string) => void,
  signal: AbortSignal,
): Promise<{ text: string; pages: number }> {
  if (signal.aborted) throw Error("已停止，未挂载文档");
  const task = loadPdf(bytes);
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, 120_000);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 2000) throw Error("PDF 超过2000页，未导入");
    const sections: string[] = [];
    let length = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal.aborted) throw Error("已取消，未挂载文档");
      progress(`正在读取 PDF · ${i}/${pdf.numPages} 页`);
      const page = await pdf.getPage(i);
      const content = await readPdfTextContent(page);
      let line = "";
      for (const item of content.items) {
        if ("str" in item) line += item.str + (item.hasEOL ? "\n" : " ");
      }
      length += line.length;
      if (length > 2 * 1024 * 1024)
        throw Error("PDF 可检索文字超过处理预算，未导入");
      if (line.trim()) sections.push(`## 第 ${i} 页\n\n${line.trim()}`);
      page.cleanup();
    }
    return { text: sections.join("\n\n"), pages: pdf.numPages };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    await task.destroy();
  }
}
