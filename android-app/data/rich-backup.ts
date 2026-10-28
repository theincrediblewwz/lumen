import type { PortableGraphManifest } from "./portable-knowledge";
import { requiredRichAssets } from "./rich-document-store";
export type OriginalAsset = {
  projectId: string;
  sourceId: string;
  sha256: string;
  size: number;
  mediaType: string;
};
export function validateOriginalAssets(
  value: unknown,
  projects: PortableGraphManifest[],
): OriginalAsset[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw Error("备份原件清单无效");
  const seen = new Set<string>();
  let total = 0;
  const result = value.map((item: any) => {
    const source = projects
      .find((p) => p.project.id === item?.projectId)
      ?.sourceItems?.find((s) => s.id === item?.sourceId);
    const key = `${item?.projectId}/${item?.sourceId}`;
    if (
      !source ||
      seen.has(key) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > 32 * 1024 * 1024 ||
      item.mediaType !== source.mediaType ||
      item.size !== source.byteSize
    )
      throw Error("备份原件与来源不匹配");
    seen.add(key);
    total += item.size;
    if (total > 512 * 1024 * 1024) throw Error("备份原件总量超过512MiB");
    return {
      projectId: item.projectId,
      sourceId: item.sourceId,
      sha256: item.sha256,
      size: item.size,
      mediaType: item.mediaType,
    };
  });
  for (const project of projects)
    for (const ref of requiredRichAssets(project.documents))
      if (
        !result.some(
          (a) =>
            a.projectId === project.project.id &&
            a.sha256 === ref.sha256 &&
            a.size === ref.size &&
            a.mediaType === ref.media_type,
        )
      )
        throw Error("备份缺少图文或PDF依赖原件，未写入不完整备份");
  return result;
}
