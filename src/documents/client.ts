import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { api, rememberBoardRevision, type BoardFile } from "../api";
import { loadWritePolicy } from "../ai/boardOperations";
import {
  requestEditorFlush,
  releaseEditorLock,
  notifyLibraryChanged,
} from "../sync/events";
import type { DocumentPayload, DocumentAsset } from "./core";
import { isPdfCompatibilityError } from "./pdfText";
export const documentPayload = (
  projectId: string,
  boardId: string,
  path: string,
  expectedScope?: string,
) =>
  invoke<DocumentPayload>("document_payload", {
    projectId,
    boardId,
    path,
    expectedScope,
  });
export const assetBytes = (
  projectId: string,
  boardId: string,
  path: string,
  asset: DocumentAsset,
  expectedScope?: string,
) =>
  invoke<ArrayBuffer>("document_asset_read", {
    projectId,
    boardId,
    path,
    assetPath: asset.path,
    expectedScope,
  }).then((b) => new Uint8Array(b));
export async function exportDocument(
  projectId: string,
  boardId: string,
  path: string,
  title: string,
) {
  const payload = await documentPayload(projectId, boardId, path),
    ext =
      payload.attachment?.kind === "pdf"
        ? "pdf"
        : payload.attachment
          ? "zip"
          : "md";
  const destination = await save({
    title: "导出文档原件",
    defaultPath:
      title.replace(/[<>:"/\\|?*\r\n]/g, "_").slice(0, 120) + "." + ext,
    filters: [
      {
        name: ext === "zip" ? "Markdown 与图片包" : ext.toUpperCase(),
        extensions: [ext],
      },
    ],
  });
  if (destination)
    await invoke("document_export", {
      projectId,
      boardId,
      path,
      destination,
      expectedScope: payload.scope,
    });
  return destination;
}
export async function attachDocument(
  board: BoardFile,
  nodeId: string,
  srcPath: string,
  progress: (text: string) => void,
  signal: AbortSignal,
): Promise<BoardFile> {
  const permission = await loadWritePolicy();
  if (!permission.scope) throw Error("请先选择资料目录");
  let sourceHash = "",
    pdfText = "",
    pages = 0;
  if (/\.pdf$/i.test(srcPath)) {
    progress("正在读取 PDF 原件");
    const source = new Uint8Array(
      await invoke<ArrayBuffer>("attachment_source", { srcPath }),
    );
    if (signal.aborted) throw Error("已停止，未挂载文档");
    sourceHash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          source.slice().buffer as ArrayBuffer,
        ),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    let engine: typeof import("./pdf") | undefined;
    try {
      engine = await import("./pdf");
    } catch {
      progress("当前系统的 PDF 引擎不可用，保留原件供系统阅读器打开");
    }
    if (engine) {
      try {
        const extracted = await engine.extractPdf(source, progress, signal);
        pdfText = extracted.text;
        pages = extracted.pages;
      } catch (error) {
        if (signal.aborted || !isPdfCompatibilityError(error)) throw error;
        progress("当前系统无法提取 PDF 文字，保留原件供阅读与导出");
      }
    }
  }
  if (signal.aborted) throw Error("已取消，未挂载文档");
  progress("正在保存文档与原件");
  let locked = false;
  try {
    await requestEditorFlush();
    locked = true;
    if (signal.aborted) throw Error("已取消，未挂载文档");
    const latest = await api.boardLoad(board.projectId, board.id);
    if (signal.aborted) throw Error("已取消，未挂载文档");
    const result = await invoke<BoardFile>("attachment_attach", {
      projectId: board.projectId,
      boardId: board.id,
      nodeId,
      srcPath,
      sourceHash,
      pdfText,
      pages,
      expectedRevision: latest._disk_revision ?? "",
      expectedScope: permission.scope,
    });
    // Bind the exact native snapshot to its revision. Never borrow a newer revision for an older graph.
    rememberBoardRevision(result);
    return result;
  } finally {
    if (locked) await releaseEditorLock().catch(() => {});
  }
}
export async function exportBoardPackage(
  projectId: string,
  boardId: string,
  title: string,
) {
  const { scope } = await loadWritePolicy();
  if (!scope) throw Error("请先选择资料目录");
  const destination = await save({
    title: "导出完整白板资料包",
    defaultPath: title.replace(/[<>:"/\\|?*\r\n]/g, "_") + ".lumen.zip",
    filters: [{ name: "Lumen 白板资料包", extensions: ["zip"] }],
  });
  if (!destination) return;
  let locked = false;
  try {
    await requestEditorFlush();
    locked = true;
    await invoke("board_package_export", {
      projectId,
      boardId,
      destination,
      expectedScope: scope,
    });
  } finally {
    if (locked) await releaseEditorLock().catch(() => {});
  }
  return destination;
}
export async function importBoardPackage(
  projectId: string,
): Promise<BoardFile | undefined> {
  const { scope } = await loadWritePolicy();
  if (!scope) throw Error("请先选择资料目录");
  const srcPath = await open({
    title: "导入白板资料包（创建副本）",
    multiple: false,
    filters: [{ name: "Lumen 白板资料包", extensions: ["zip"] }],
  });
  if (typeof srcPath !== "string") return;
  const board = await invoke<BoardFile>("board_package_import", {
    projectId,
    srcPath,
    expectedScope: scope,
  });
  await notifyLibraryChanged();
  return board;
}
