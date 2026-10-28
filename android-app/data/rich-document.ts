export const DOCUMENT_PREFIX = "<!-- lumen-document/v1\n";
const END = "\n-->\n\n";
export type DocumentAsset = {
  path: string;
  sha256: string;
  size: number;
  media_type: string;
};
export type DocumentMetadata = {
  schema: "lumen-document/v1";
  kind: "pdf" | "markdown_bundle";
  original: DocumentAsset;
  images: Record<string, DocumentAsset>;
  pages: number;
  extraction: string;
};
export type DocumentPayload = {
  markdown: string;
  attachment: DocumentMetadata | null;
  scope?: string;
};
export function splitDocument(raw: string): DocumentPayload {
  if (!raw.startsWith(DOCUMENT_PREFIX))
    return { markdown: raw, attachment: null };
  const end = raw.indexOf(END, DOCUMENT_PREFIX.length);
  if (end < 0 || end > 512 * 1024) throw Error("附件清单损坏，原件仍保留");
  const value = JSON.parse(
    raw.slice(DOCUMENT_PREFIX.length, end),
  ) as DocumentMetadata;
  if (
    value.schema !== "lumen-document/v1" ||
    !Number.isSafeInteger(value.pages) ||
    value.pages < 0 ||
    value.pages > 2000 ||
    !["ready", "empty", "unavailable"].includes(value.extraction) ||
    !["pdf", "markdown_bundle"].includes(value.kind) ||
    !value.images ||
    typeof value.images !== "object" ||
    Array.isArray(value.images) ||
    Object.keys(value.images).length > 256
  )
    throw Error("不支持的附件清单");
  for (const asset of [value.original, ...Object.values(value.images)]) {
    const mimes: Record<string, string> = {
      pdf: "application/pdf",
      zip: "application/zip",
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    if (
      !asset ||
      !/^docs\/asset_[a-f0-9]{64}\.(pdf|zip|png|jpg|gif|webp)$/.test(
        asset.path,
      ) ||
      !asset.path.includes(`asset_${asset.sha256}.`) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      asset.size > 32 * 1024 * 1024 ||
      asset.media_type !== mimes[asset.path.split(".").pop()!]
    )
      throw Error("附件校验信息无效");
  }
  if (
    (value.kind === "pdf" && value.original.media_type !== "application/pdf") ||
    (value.kind === "markdown_bundle" &&
      value.original.media_type !== "application/zip")
  )
    throw Error("附件类型不符");
  for (const [alias, asset] of Object.entries(value.images))
    if (
      !alias.startsWith("images/") ||
      alias.includes("\\") ||
      alias.includes(":") ||
      /[\u0000-\u001f]/.test(alias) ||
      alias.split("/").some((c) => c === "." || c === "..") ||
      !asset.media_type.startsWith("image/")
    )
      throw Error("图片别名无效");
  return { markdown: raw.slice(end + END.length), attachment: value };
}
export function imageAlias(href: string): string | null {
  try {
    const path = decodeURIComponent(href);
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes(":") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    )
      return null;
    return path.replace(/^\.\//, "");
  } catch {
    return null;
  }
}

export function documentText(raw: string): string {
  return splitDocument(raw).markdown;
}
export function withDocumentText(raw: string, body: string): string {
  const { attachment } = splitDocument(raw);
  return attachment
    ? DOCUMENT_PREFIX + JSON.stringify(attachment) + "\n-->\n\n" + body
    : body;
}
export function documentAssets(raw: string): DocumentAsset[] {
  const { attachment } = splitDocument(raw);
  return attachment
    ? [attachment.original, ...Object.values(attachment.images)]
    : [];
}
export function documentPreview(raw: string): string {
  let parsed: DocumentPayload;
  try {
    parsed = splitDocument(raw);
  } catch {
    return "附件清单损坏，请从完整备份恢复；原文件仍保留。";
  }
  if (!parsed.attachment) return parsed.markdown;
  return (
    `${parsed.attachment.kind === "pdf" ? "PDF" : "图文 Markdown"} · 原件已保留\n\n` +
    parsed.markdown
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "[图片]")
      .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
      .replace(/\$\$[\s\S]*?\$\$/g, "[公式]")
      .slice(0, 240)
  );
}

export function documentModelText(raw: string): string {
  const { markdown, attachment } = splitDocument(raw);
  return attachment
    ? `[${attachment.kind === "pdf" ? "PDF分页文字" : "图文Markdown"}；仅提供文字，原件和图片没有作为视觉输入发送。]\n\n${markdown}`
    : markdown;
}
