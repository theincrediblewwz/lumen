import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

// Some shipping WKWebViews support stream readers but not async stream iteration.
// Avoid PDF.js getTextContent's for-await here, for both extraction and selection.
export async function readPdfTextContent(
  page: Pick<PDFPageProxy, "streamTextContent">,
): Promise<TextContent> {
  const reader = page.streamTextContent().getReader();
  const content: TextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return content;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      for (const item of value.items) content.items.push(item);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isPdfCompatibilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TypeError" ||
    /undefined is not a function|is not async iterable|Symbol\.asyncIterator/i.test(
      error.message,
    )
  );
}
