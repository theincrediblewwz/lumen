import type { SQLiteDatabase } from "expo-sqlite";
import type { PreparedRichDocument } from "./rich-archive";
import {
  documentAssets,
  documentText,
  type DocumentAsset,
} from "./rich-document";
const id = (p: string) =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
export async function attachRichDocument(
  db: SQLiteDatabase,
  projectId: string,
  nodeId: string,
  prepared: PreparedRichDocument,
  uris: Map<string, string>,
) {
  let documentId = "";
  const now = new Date().toISOString(),
    path = `docs/rich_${prepared.metadata.original.sha256}.md`;
  await db.withExclusiveTransactionAsync(async (tx) => {
    if (
      !(await tx.getFirstAsync(
        "SELECT id FROM nodes WHERE id=? AND project_id=?",
        nodeId,
        projectId,
      ))
    )
      throw Error("节点已改变或不属于当前白板，未挂载");
    const existing = await tx.getFirstAsync<{ id: string; body: string }>(
      "SELECT id,body FROM documents WHERE project_id=? AND path=?",
      projectId,
      path,
    );
    if (existing) {
      if (
        documentAssets(existing.body)[0]?.sha256 !==
        prepared.metadata.original.sha256
      )
        throw Error("资料路径冲突");
      documentId = existing.id;
    } else {
      documentId = id("doc");
      await tx.runAsync(
        "INSERT INTO documents(id,project_id,path,title,body,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        documentId,
        projectId,
        path,
        prepared.title,
        prepared.body,
        "source",
        now,
        now,
      );
      const seen = new Set<string>();
      for (const ref of documentAssets(prepared.body)) {
        if (seen.has(ref.sha256)) continue;
        seen.add(ref.sha256);
        const uri = uris.get(ref.sha256);
        if (!uri || !uri.endsWith(`/sync-blobs/${ref.sha256}`))
          throw Error("原件未完整保存，未挂载");
        const kind =
          ref.media_type === "application/pdf"
            ? "pdf"
            : ref.media_type.startsWith("image/")
              ? "image"
              : "markdown";
        const old = await tx.getFirstAsync<{
          id: string;
          asset_uri: string | null;
          byte_size: number;
          media_type: string;
        }>(
          "SELECT id,asset_uri,byte_size,media_type FROM source_items WHERE project_id=? AND content_hash=? AND kind=?",
          projectId,
          ref.sha256,
          kind,
        );
        if (old) {
          if (old.byte_size !== ref.size || old.media_type !== ref.media_type)
            throw Error("已有原件校验信息冲突");
          if (old.asset_uri !== uri)
            await tx.runAsync(
              "UPDATE source_items SET asset_uri=?,updated_at=? WHERE id=?",
              uri,
              now,
              old.id,
            );
          continue;
        }
        const sourceId = id("source");
        await tx.runAsync(
          "INSERT INTO source_items(id,project_id,kind,title,original_name,media_type,asset_uri,source_url,content_hash,byte_size,extraction_status,extraction_error,derived_document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?,'ready',NULL,?,?,?)",
          sourceId,
          projectId,
          kind,
          ref.sha256 === prepared.metadata.original.sha256
            ? prepared.title
            : ref.path.split("/").pop()!,
          ref.path.split("/").pop()!,
          ref.media_type,
          uri,
          ref.sha256,
          ref.size,
          documentId,
          now,
          now,
        );
        if (ref.sha256 === prepared.metadata.original.sha256) {
          for (const [ordinal, page] of prepared.pages.entries()) {
            if (!page.text.trim()) continue;
            await tx.runAsync(
              "INSERT INTO source_segments(id,source_item_id,ordinal,locator_type,locator,body,content_hash) VALUES(?,?,?,?,?,?,?)",
              id("segment"),
              sourceId,
              ordinal,
              "page",
              `第 ${page.page} 页`,
              page.text,
              page.contentHash,
            );
          }
        }
      }
    }
    if (
      !(await tx.getFirstAsync(
        "SELECT id FROM node_documents WHERE node_id=? AND document_id=?",
        nodeId,
        documentId,
      ))
    ) {
      const rank = await tx.getFirstAsync<{ rank: number }>(
        "SELECT COALESCE(MAX(sort_order),0)+1 AS rank FROM node_documents WHERE node_id=?",
        nodeId,
      );
      await tx.runAsync(
        "INSERT INTO node_documents(id,node_id,document_id,sort_order) VALUES(?,?,?,?)",
        id("link"),
        nodeId,
        documentId,
        rank?.rank ?? 1,
      );
    }
    await tx.runAsync(
      "UPDATE projects SET updated_at=? WHERE id=?",
      now,
      projectId,
    );
  });
  return documentId;
}
export async function richSourceRows(db: SQLiteDatabase, projectId: string) {
  return db.getAllAsync<{
    id: string;
    content_hash: string;
    byte_size: number;
    media_type: string;
    asset_uri: string | null;
  }>(
    "SELECT id,content_hash,byte_size,media_type,asset_uri FROM source_items WHERE project_id=?",
    projectId,
  );
}
export function requiredRichAssets(
  documents: { body: string }[],
): DocumentAsset[] {
  const refs = new Map<string, DocumentAsset>();
  for (const doc of documents)
    for (const ref of documentAssets(doc.body)) {
      const old = refs.get(ref.sha256);
      if (old && (old.size !== ref.size || old.media_type !== ref.media_type))
        throw Error("附件清单之间存在冲突");
      refs.set(ref.sha256, ref);
    }
  return [...refs.values()];
}
export function readableDocument(raw: string) {
  return documentText(raw);
}
