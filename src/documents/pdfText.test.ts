import { describe, expect, it, vi } from "vitest";
import { readPdfTextContent } from "./pdfText";

describe("PDF text on WKWebView without async stream iteration", () => {
  it("reads multiple chunks using only the reader API and preserves text, fonts and language", async () => {
    const chunks = [
      { items: [{ str: "公式与证据", hasEOL: true }], styles: { f1: { fontFamily: "A" } }, lang: null },
      { items: [{ str: "Page two" }], styles: { f2: { fontFamily: "B" } }, lang: "zh-CN" },
    ];
    const before = structuredClone(chunks);
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ value: chunks[0], done: false })
        .mockResolvedValueOnce({ value: chunks[1], done: false })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: vi.fn(), cancel: vi.fn(),
    };
    // Deliberately no Symbol.asyncIterator, as on affected Safari/WKWebViews.
    const page = { streamTextContent: () => ({ getReader: () => reader }) };
    const result = await readPdfTextContent(page as never);
    expect(result).toEqual({ items: chunks.flatMap(c => c.items), styles: { ...chunks[0].styles, ...chunks[1].styles }, lang: "zh-CN" });
    expect(chunks).toEqual(before);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it("propagates stream failure and releases the reader without retaining partial text", async () => {
    const error = new Error("PDF stream failed");
    const reader = { read: vi.fn().mockRejectedValue(error), cancel: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn() };
    await expect(readPdfTextContent({ streamTextContent: () => ({ getReader: () => reader }) } as never)).rejects.toBe(error);
    expect(reader.cancel).toHaveBeenCalledWith(error);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
