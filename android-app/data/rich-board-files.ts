import type { SQLiteDatabase } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import * as Picker from "expo-document-picker";
import * as FS from "expo-file-system/legacy";
import {
  createPortableManifest,
  importPortableManifestWithMapping,
  type PortableGraphManifest,
} from "./portable-knowledge";
import {
  nativeBoardPackage,
  lumenBoardPackage,
  parseBoardPackage,
} from "./rich-board-package";
import { validateOriginalAssets, type OriginalAsset } from "./rich-backup";
import { sha256, syncAssets, readSyncBlob } from "@/sync/assets";
export async function collectOriginals(
  db: SQLiteDatabase,
  manifest: PortableGraphManifest,
) {
  const rows = await db.getAllAsync<{
    id: string;
    asset_uri: string | null;
    media_type: string;
    byte_size: number;
  }>(
    "SELECT id,asset_uri,media_type,byte_size FROM source_items WHERE project_id=?",
    manifest.project.id,
  );
  const refs: OriginalAsset[] = [];
  let missing = 0;
  for (const row of rows) {
    if (!row.asset_uri) {
      if (manifest.sourceItems?.find((s) => s.id === row.id)?.originalName)
        missing++;
      continue;
    }
    const ref = await syncAssets.exportFile(row.asset_uri, row.media_type);
    if (ref.size !== row.byte_size) throw Error("原件大小与来源不一致");
    refs.push({
      projectId: manifest.project.id,
      sourceId: row.id,
      sha256: ref.sha256,
      size: ref.size,
      mediaType: row.media_type,
    });
  }
  return { originals: validateOriginalAssets(refs, [manifest]), missing };
}
export async function exportRichBoard(
  db: SQLiteDatabase,
  projectId: string,
  desktop = false,
  progress: (s: string) => void = () => {},
) {
  const permission =
    await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return;
  let manifest: PortableGraphManifest | null = null;
  let originals: OriginalAsset[] = [],
    missing = 0;
  progress("正在校验白板与原件…");
  await db.withExclusiveTransactionAsync(async (tx) => {
    manifest = await createPortableManifest(tx, projectId);
    const collected = await collectOriginals(tx, manifest);
    originals = collected.originals;
    missing = collected.missing;
  });
  const frozen = manifest as unknown as PortableGraphManifest;
  progress("正在打包原件、图片和对话…");
  const bytes = await (desktop ? lumenBoardPackage : nativeBoardPackage)(
    frozen,
    originals,
    (ref) =>
      readSyncBlob({
        sha256: ref.sha256,
        size: ref.size,
        mediaType: ref.mediaType,
      }),
    sha256,
  );
  const name = `${frozen.project.title.replace(/[<>:"/\\|?*\r\n]/g, "_")}.${desktop ? "lumen" : "learnstuff"}.zip`;
  const uri = await FS.StorageAccessFramework.createFileAsync(
    permission.directoryUri,
    name,
    "application/zip",
  );
  new File(uri).write(bytes);
  if ((await sha256(await new File(uri).bytes())) !== (await sha256(bytes)))
    throw Error("资料包写入校验失败");
  return { name, missing, originals: originals.length };
}
export async function importRichBoard(
  db: SQLiteDatabase,
  progress: (s: string) => void = () => {},
) {
  const picked = await Picker.getDocumentAsync({
    type: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
    ],
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return;
  const file = new File(picked.assets[0].uri);
  try {
    if (file.size > 96 * 1024 * 1024) throw Error("白板包最多96MiB");
    progress("正在核对资料包与每个原件…");
    const parsed = await parseBoardPackage(await file.bytes(), sha256);
    const uris = new Map<string, string>();
    for (const ref of parsed.originals) {
      const bytes = parsed.files[`assets/${ref.sha256}.bin`];
      uris.set(
        ref.sourceId,
        await syncAssets.install(
          { sha256: ref.sha256, size: ref.size, mediaType: ref.mediaType },
          bytes,
        ),
      );
    }
    if (parsed.manifest.knowledgeLibrary)
      parsed.manifest.knowledgeLibrary.settings = [];
    progress("正在创建白板副本…");
    const result = await importPortableManifestWithMapping(
      db,
      parsed.manifest,
      uris,
    );
    return result.projectId;
  } finally {
    if (file.uri.startsWith(Paths.cache.uri) && file.exists)
      try {
        file.delete();
      } catch {
        /* Picker copy only. */
      }
  }
}
