import { File, Paths } from "expo-file-system";
import * as Picker from "expo-document-picker";
import type { SQLiteDatabase } from "expo-sqlite";
import Native from "@/modules/expo-content-extractor";
import { sha256, syncAssets, readSyncBlob } from "@/sync/assets";
import {
  prepareRichDocument,
  plainMarkdown,
  ATTACHMENT_LIMIT,
  writeArchive,
  strToU8,
} from "./rich-archive";
import { attachRichDocument } from "./rich-document-store";
import {
  documentAssets,
  splitDocument,
  type DocumentAsset,
  type DocumentMetadata,
} from "./rich-document";
import { addNodeDocument } from "./node-workspace";
export async function verifiedAssetUri(ref: DocumentAsset) {
  return syncAssets.localUri({
    sha256: ref.sha256,
    size: ref.size,
    mediaType: ref.media_type,
  });
}
export async function legacyPdfMetadata(
  db: SQLiteDatabase,
  documentId: string,
): Promise<DocumentMetadata | null> {
  const row = await db.getFirstAsync<{
    asset_uri: string;
    extraction_status: string;
  }>(
    "SELECT asset_uri,extraction_status FROM source_items WHERE derived_document_id=? AND kind='pdf' AND asset_uri IS NOT NULL LIMIT 1",
    documentId,
  );
  if (!row) return null;
  const ref = await syncAssets.exportFile(row.asset_uri, "application/pdf");
  return {
    schema: "lumen-document/v1",
    kind: "pdf",
    original: {
      path: `docs/asset_${ref.sha256}.pdf`,
      sha256: ref.sha256,
      size: ref.size,
      media_type: "application/pdf",
    },
    images: {},
    pages: 0,
    extraction: row.extraction_status === "ready" ? "ready" : "unavailable",
  };
}
export async function pickNodeDocument(
  db: SQLiteDatabase,
  nodeId: string,
  projectId: string,
  progress: (s: string) => void,
  signal: AbortSignal,
) {
  const result = await Picker.getDocumentAsync({
    type: [
      "text/markdown",
      "text/plain",
      "application/pdf",
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
    ],
    copyToCacheDirectory: true,
  });
  if (result.canceled) return;
  const selected = result.assets?.[0];
  if (!selected?.uri) throw Error("未取得文件");
  const file = new File(selected.uri);
  const token = `document-${Date.now()}-${Math.random()}`;
  let inspecting = false;
  const stop = () => {
    if (inspecting) Native.cancelDocumentTask(token);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (file.size > ATTACHMENT_LIMIT) throw Error("单份资料最多32MiB");
    progress("正在读取并校验原件…");
    const bytes = await file.bytes();
    if (signal.aborted) throw Error("已停止，尚未挂载");
    if (!/\.(pdf|zip)$/i.test(selected.name)) {
      const text = plainMarkdown(bytes);
      if (signal.aborted) throw Error("已停止，尚未挂载");
      progress("正在保存挂载…");
      return await addNodeDocument(
        db,
        nodeId,
        selected.name.replace(/\.(md|markdown|txt)$/i, ""),
        text,
      );
    }
    let pages: { page: number; text: string }[] = [];
    if (/\.pdf$/i.test(selected.name)) {
      progress("正在提取 PDF 文字；原件将完整保留…");
      inspecting = true;
      try {
        pages = await Native.inspectPdfAsync(file.uri, token);
      } finally {
        inspecting = false;
      }
    }
    progress("正在整理图片与正文…");
    const prepared = await prepareRichDocument(
      selected.name,
      bytes,
      sha256,
      pages,
    );
    if (signal.aborted) throw Error("已停止，尚未挂载");
    const uris = new Map<string, string>();
    for (const ref of documentAssets(prepared.body)) {
      if (signal.aborted) throw Error("已停止，尚未挂载");
      const data = prepared.files[ref.path];
      uris.set(
        ref.sha256,
        await syncAssets.install(
          { sha256: ref.sha256, size: ref.size, mediaType: ref.media_type },
          data,
        ),
      );
    }
    if (signal.aborted) throw Error("已停止，尚未挂载");
    progress("正在保存挂载…");
    return await attachRichDocument(db, projectId, nodeId, prepared, uris);
  } finally {
    signal.removeEventListener("abort", stop);
    if (file.uri.startsWith(Paths.cache.uri) && file.exists)
      try {
        file.delete();
      } catch {
        /* Picker copy only. */
      }
  }
}
export async function exportNodeDocument(raw: string, title: string) {
  const { attachment, markdown } = splitDocument(raw);
  let bytes: Uint8Array, extension: string, mime: string;
  if (attachment?.kind === "pdf") {
    bytes = await readSyncBlob({
      sha256: attachment.original.sha256,
      size: attachment.original.size,
      mediaType: attachment.original.media_type,
    });
    extension = "pdf";
    mime = "application/pdf";
  } else if (attachment) {
    const files: Record<string, Uint8Array> = {
      "answer.md": strToU8(markdown),
    };
    for (const [alias, ref] of Object.entries(attachment.images))
      files[alias] = await readSyncBlob({
        sha256: ref.sha256,
        size: ref.size,
        mediaType: ref.media_type,
      });
    bytes = writeArchive(files);
    extension = "zip";
    mime = "application/zip";
  } else {
    bytes = strToU8(markdown);
    extension = "md";
    mime = "text/markdown";
  }
  const FS = await import("expo-file-system/legacy");
  const permission =
    await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return;
  const uri = await FS.StorageAccessFramework.createFileAsync(
    permission.directoryUri,
    `${title.replace(/[<>:"/\\|?*\r\n]/g, "_")}.${extension}`,
    mime,
  );
  const target = new File(uri);
  target.write(bytes);
  if ((await sha256(await target.bytes())) !== (await sha256(bytes)))
    throw Error("导出文件校验失败，请重试");
  return uri;
}
