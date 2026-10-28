import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  DOCUMENT_PREFIX,
  splitDocument,
  type DocumentAsset,
  type DocumentMetadata,
} from "./rich-document";
export type Digest = (bytes: Uint8Array) => Promise<string>;
export const ATTACHMENT_LIMIT = 32 * 1024 * 1024;
export function utf8Text(bytes: Uint8Array): string {
  const text = strFromU8(bytes),
    encoded = strToU8(text);
  if (
    encoded.length !== bytes.length ||
    encoded.some((b, i) => b !== bytes[i]) ||
    text.includes("\0")
  )
    throw Error("文档必须为有效UTF-8文字");
  return text;
}
export function plainMarkdown(bytes: Uint8Array): string {
  const text = utf8Text(bytes);
  if (text.length > 1_000_000)
    throw Error("请选择100万字符以内的UTF-8 Markdown");
  if (splitDocument(text).attachment)
    throw Error("带原件清单的文档请通过完整白板ZIP或原始PDF／图文ZIP导入");
  return text;
}

export function safeArchiveName(name: string): boolean {
  return (
    !!name &&
    !name.includes("\\") &&
    name
      .split("/")
      .every(
        (n) =>
          !!n &&
          n !== "." &&
          n !== ".." &&
          n !== "__proto__" &&
          !/[. ]$|[<>:"|?*\u0000-\u001f]/.test(n) &&
          !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(n),
      )
  );
}
const u16 = (v: DataView, n: number) => v.getUint16(n, true),
  u32 = (v: DataView, n: number) => v.getUint32(n, true);
export function readArchive(
  bytes: Uint8Array,
  limit = ATTACHMENT_LIMIT,
  maxFiles = 512,
): Record<string, Uint8Array> {
  if (bytes.length > limit) throw Error("ZIP超过处理预算");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (u32(v, i) === 0x06054b50 && i + 22 + u16(v, i + 20) === bytes.length) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    u16(v, end + 4) ||
    u16(v, end + 6) ||
    u16(v, end + 8) !== u16(v, end + 10)
  )
    throw Error("ZIP目录无效");
  const count = u16(v, end + 10);
  if (count > maxFiles) throw Error("ZIP文件过多");
  let cursor = u32(v, end + 16),
    total = 0;
  const names = new Map<string, string>(),
    expected = new Map<string, { size: number; crc: number }>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(v, cursor) !== 0x02014b50)
      throw Error("ZIP目录损坏");
    const length = u16(v, cursor + 28),
      extra = u16(v, cursor + 30),
      comment = u16(v, cursor + 32),
      size = u32(v, cursor + 24),
      offset = u32(v, cursor + 42);
    const name = strFromU8(bytes.subarray(cursor + 46, cursor + 46 + length));
    const directory = name.endsWith("/"),
      path = directory ? name.slice(0, -1) : name;
    if (
      !safeArchiveName(path) ||
      path.length > 240 ||
      u16(v, cursor + 8) & 1 ||
      ![0, 8].includes(u16(v, cursor + 10)) ||
      ((u32(v, cursor + 38) >>> 16) & 0xf000) === 0xa000 ||
      offset + 30 >= cursor ||
      u32(v, offset) !== 0x04034b50
    )
      throw Error("ZIP含不安全或加密文件");
    const localName = strFromU8(
      bytes.subarray(offset + 30, offset + 30 + u16(v, offset + 26)),
    );
    if (localName !== name) throw Error("ZIP文件名不一致");
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix ? prefix + "/" + part : part;
      const key = prefix.normalize("NFC").toLowerCase();
      if (names.has(key) && names.get(key) !== prefix)
        throw Error("ZIP路径大小写或Unicode冲突");
      names.set(key, prefix);
    }
    if (expected.has(name)) throw Error("ZIP重复文件");
    total += size;
    if (total > limit || size === 0xffffffff) throw Error("ZIP解压内容过大");
    expected.set(name, { size, crc: u32(v, cursor + 16) });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw Error("ZIP目录长度不符");
  const files = unzipSync(bytes, {
    filter: (file) => {
      const entry = expected.get(file.name);
      if (!entry || entry.size !== file.originalSize)
        throw Error("ZIP清单不一致");
      return !file.name.endsWith("/");
    },
  });
  if (
    Object.keys(files).length !==
    [...expected.keys()].filter((n) => !n.endsWith("/")).length
  )
    throw Error("ZIP文件缺失");
  for (const [name, entry] of expected) {
    if (name.endsWith("/")) continue;
    const data = Object.hasOwn(files, name) ? files[name] : null;
    if (!data || data.length !== entry.size || crc32(data) !== entry.crc)
      throw Error("ZIP文件校验失败");
  }
  return files;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function writeArchive(files: Record<string, Uint8Array>) {
  for (const p of Object.keys(files))
    if (!safeArchiveName(p)) throw Error("归档路径不安全");
  return zipSync(files, { level: 0 });
}
export type PreparedRichDocument = {
  title: string;
  body: string;
  metadata: DocumentMetadata;
  files: Record<string, Uint8Array>;
  pages: { page: number; text: string; contentHash: string }[];
};
async function asset(
  bytes: Uint8Array,
  ext: string,
  media_type: string,
  hash: Digest,
): Promise<DocumentAsset> {
  const sha256 = await hash(bytes);
  return {
    path: `docs/asset_${sha256}.${ext}`,
    sha256,
    size: bytes.length,
    media_type,
  };
}
function raster(data: Uint8Array): [string, string] {
  if (data[0] === 137 && strFromU8(data.subarray(1, 4)) === "PNG")
    return ["png", "image/png"];
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return ["jpg", "image/jpeg"];
  if (strFromU8(data.subarray(0, 3)) === "GIF") return ["gif", "image/gif"];
  if (
    strFromU8(data.subarray(0, 4)) === "RIFF" &&
    strFromU8(data.subarray(8, 12)) === "WEBP"
  )
    return ["webp", "image/webp"];
  throw Error("ZIP图片无效，仅支持PNG/JPEG/GIF/WebP");
}
export async function prepareRichDocument(
  name: string,
  raw: Uint8Array,
  hash: Digest,
  pages: { page: number; text: string }[] = [],
): Promise<PreparedRichDocument> {
  if (!raw.length || raw.length > ATTACHMENT_LIMIT)
    throw Error("单份资料最多32MiB");
  const files: Record<string, Uint8Array> = {},
    images: Record<string, DocumentAsset> = {};
  let text = "",
    original: DocumentAsset,
    kind: DocumentMetadata["kind"];
  if (/\.pdf$/i.test(name)) {
    if (strFromU8(raw.subarray(0, 5)) !== "%PDF-") throw Error("PDF文件头无效");
    kind = "pdf";
    original = await asset(raw, "pdf", "application/pdf", hash);
    text = pages
      .map((p) => `## 第 ${p.page} 页\n\n${p.text.trim()}`)
      .join("\n\n");
    if (!pages.some((p) => p.text.trim()))
      text =
        "这份PDF没有提取到可用文字。原件可以阅读；AI尚未读取图像中的内容。";
  } else {
    kind = "markdown_bundle";
    original = await asset(raw, "zip", "application/zip", hash);
    const entries = readArchive(raw);
    const docs = Object.keys(entries).filter(
      (p) =>
        !p.includes("/") &&
        /\.(md|markdown)$/i.test(p) &&
        p.toLowerCase() !== "export-notes.md",
    );
    const primary =
      docs.find((p) => p.toLowerCase() === "answer.md") ??
      (docs.length === 1 ? docs[0] : null);
    if (!primary) throw Error("ZIP根目录需要answer.md或唯一Markdown正文");
    text = plainMarkdown(entries[primary]);
    for (const [p, data] of Object.entries(entries)) {
      if (p === primary || p.toLowerCase() === "export-notes.md") continue;
      if (!p.startsWith("images/"))
        throw Error("ZIP含未知文件，请使用Markdown与images格式");
      if (Object.keys(images).length >= 256)
        throw Error("图片超过256张处理预算");
      const [ext, mime] = raster(data);
      const ref = await asset(data, ext, mime, hash);
      images[p] = ref;
      files[ref.path] = data;
    }
  }
  files[original.path] = raw;
  const metadata: DocumentMetadata = {
    schema: "lumen-document/v1",
    kind,
    original,
    images,
    pages: pages.length,
    extraction:
      kind === "pdf"
        ? pages.some((p) => p.text.trim())
          ? "ready"
          : "empty"
        : "ready",
  };
  const body = DOCUMENT_PREFIX + JSON.stringify(metadata) + "\n-->\n\n" + text;
  if (body.length > 1_000_000)
    throw Error("资料正文与清单超过100万字符，请拆分资料");
  const hashedPages = await Promise.all(
    pages.map(async (page) => ({
      ...page,
      contentHash: await hash(strToU8(page.text)),
    })),
  );
  return {
    title: name.replace(/\.[^.]+$/, "").slice(0, 160) || "导入资料",
    body,
    metadata,
    files,
    pages: hashedPages,
  };
}
export { strFromU8, strToU8 };
