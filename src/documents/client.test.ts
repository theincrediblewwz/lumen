import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFile } from "../api";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), policy: vi.fn(), load: vi.fn(), remember: vi.fn(), flush: vi.fn(), release: vi.fn(), extract: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../api", () => ({ api: { boardLoad: mocks.load }, rememberBoardRevision: mocks.remember }));
vi.mock("../ai/boardOperations", () => ({ loadWritePolicy: mocks.policy }));
vi.mock("../sync/events", () => ({ requestEditorFlush: mocks.flush, releaseEditorLock: mocks.release, notifyLibraryChanged: vi.fn() }));
vi.mock("./pdf", () => ({ extractPdf: mocks.extract }));
import { attachDocument } from "./client";
const board = { projectId: "p", id: "b", _disk_revision: "before" } as BoardFile;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.policy.mockResolvedValue({ scope: "synthetic-scope" });
  mocks.load.mockResolvedValue(board);
  mocks.flush.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string) => command === "attachment_source" ? new TextEncoder().encode("%PDF-synthetic original").buffer : { ...board, _disk_revision: "after" });
});
describe("PDF attachment extraction failures", () => {
  it("retains the hashed original with unavailable text on runtime compatibility failure", async () => {
    mocks.extract.mockRejectedValue(new TypeError("undefined is not a function (near '...n of t...')"));
    const progress = vi.fn();
    await attachDocument(board, "node", "synthetic.pdf", progress, new AbortController().signal);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("保留原件"));
    expect(mocks.invoke).toHaveBeenCalledWith("attachment_attach", expect.objectContaining({ pages: 0, pdfText: "", sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), expectedScope: "synthetic-scope", expectedRevision: "before" }));
    expect(mocks.remember).toHaveBeenCalledWith(expect.objectContaining({ _disk_revision: "after" }));
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not attach after cancellation during extraction, even with a compatibility error", async () => {
    const controller = new AbortController();
    mocks.extract.mockImplementation(async () => { controller.abort(); throw new TypeError("stream closed"); });
    await expect(attachDocument(board, "node", "synthetic.pdf", vi.fn(), controller.signal)).rejects.toThrow();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(["attachment_source"]);
  });
  it("cancels before native commit if the board changes while loading its revision", async () => {
    const controller = new AbortController();
    mocks.extract.mockResolvedValue({ text: "PDF text", pages: 1 });
    mocks.load.mockImplementation(async () => { controller.abort(); return board; });
    await expect(attachDocument(board, "node", "synthetic.pdf", vi.fn(), controller.signal)).rejects.toThrow("已取消");
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(["attachment_source"]);
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(["PDF 超过2000页，未导入", "PDF 可检索文字超过处理预算，未导入", "Invalid PDF structure", "No password given"])("keeps non-compatibility failures explicit: %s", async message => {
    mocks.extract.mockRejectedValue(new Error(message));
    await expect(attachDocument(board, "node", "synthetic.pdf", vi.fn(), new AbortController().signal)).rejects.toThrow(message);
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(["attachment_source"]);
  });
});
