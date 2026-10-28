import { useEffect, useState } from "react";
import { assetBytes } from "./client";
import type { DocumentMetadata } from "./core";
export function useDocumentImages(
  projectId: string,
  boardId: string,
  path: string,
  metadata: DocumentMetadata | null | undefined,
  scope?: string,
) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    setUrls({});
    setError("");
    if (!metadata || metadata.kind !== "markdown_bundle") return;
    let alive = true;
    const created: string[] = [];
    const run = async () => {
      const result: Record<string, string> = {};
      for (const asset of Object.values(metadata.images)) {
        if (result[asset.path]) continue;
        try {
          const bytes = await assetBytes(
            projectId,
            boardId,
            path,
            asset,
            scope,
          );
          if (!alive) return;
          const url = URL.createObjectURL(
            new Blob([bytes.slice().buffer as ArrayBuffer], {
              type: asset.media_type,
            }),
          );
          created.push(url);
          result[asset.path] = url;
        } catch (e) {
          if (alive) setError(`部分图片无法读取：${String(e)}`);
        }
      }
      if (alive) setUrls(result);
    };
    void run().catch((e) => {
      if (alive) setError(`图片无法读取：${String(e)}`);
    });
    return () => {
      alive = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [projectId, boardId, path, metadata, scope]);
  return { urls, error };
}
