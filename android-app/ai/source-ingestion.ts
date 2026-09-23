import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { fetch } from 'expo/fetch';
import * as ImagePicker from 'expo-image-picker';

import { normalizePublicWebUrl } from '@/ai/source-ingestion-policy';
import ExpoContentExtractor from '@/modules/expo-content-extractor';
import {
  addProjectSourceItem,
  recordFailedProjectSourceItem,
  type NewSourceItem,
  type NewSourceSegment,
} from '@/data/source-items';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { SourceItem } from '@/types/domain';

const MAX_TEXT_BYTES = 8_000_000;
const MAX_PDF_BYTES = 50_000_000;
const MAX_IMAGE_BYTES = 20_000_000;
const MAX_WEB_BYTES = 2_000_000;
const WEB_TIMEOUT_MS = 15_000;
const MAX_WEB_REDIRECTS = 3;

export type WebSourcePreview = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  mediaType: string;
  text: string;
  byteSize: number;
  truncated: boolean;
};

export async function pickAndAddDocumentSource(
  db: SQLiteDatabase,
  projectId: string,
): Promise<SourceItem | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/markdown', 'text/plain', 'text/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const mediaType = normalizeMediaType(asset.mimeType, asset.name);
  const kind = mediaType === 'application/pdf'
    ? 'pdf' as const
    : mediaType === 'text/markdown'
      ? 'markdown' as const
      : 'text' as const;
  const maxBytes = kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  try {
    assertByteLimit(asset.size ?? 0, maxBytes, kind === 'pdf' ? 'PDF' : '文字文件');

    let segments: NewSourceSegment[];
    if (kind === 'pdf') {
      const pages = await ExpoContentExtractor.extractPdfPagesAsync(asset.uri);
      segments = await Promise.all(pages
        .filter((page) => page.text.trim())
        .map(async (page, index) => ({
          ordinal: index,
          locatorType: 'page' as const,
          locator: `第 ${page.page} 页`,
          body: page.text.trim(),
          contentHash: await digest(page.text.trim()),
        })));
      if (!segments.length) {
        throw new Error('这个 PDF 的数字文本和扫描页 OCR 都没有识别到可用文字。可尝试导出清晰页面图片后使用“照片 OCR”。');
      }
    } else {
      const text = await FileSystem.readAsStringAsync(asset.uri);
      assertByteLimit(utf8ByteLength(text), MAX_TEXT_BYTES, '文字文件');
      segments = await createTextSegments(text);
    }

    const contentHash = await digest(segments.map((segment) => `${segment.locator}\n${segment.body}`).join('\n\n'));
    const assetUri = await preserveSourceAsset(projectId, asset.uri, asset.name, contentHash);
    return addProjectSourceItem(db, {
      projectId,
      kind,
      title: stripExtension(asset.name),
      originalName: asset.name,
      mediaType,
      assetUri,
      sourceUrl: null,
      contentHash,
      byteSize: asset.size ?? utf8ByteLength(segments.map((segment) => segment.body).join('')),
      segments,
    });
  } catch (error) {
    return recordFailedProjectSourceItem(db, {
      projectId,
      kind,
      title: stripExtension(asset.name),
      originalName: asset.name,
      mediaType,
      assetUri: null,
      sourceUrl: null,
      contentHash: await failedAssetHash(asset.name, mediaType, asset.size ?? 0, asset.uri),
      byteSize: asset.size ?? 0,
      error: safeExtractionError(error),
    });
  }
}

export async function pickAndAddImageSources(
  db: SQLiteDatabase,
  projectId: string,
): Promise<SourceItem[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('需要照片读取权限才能识别图片资料');
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 1,
  });
  if (result.canceled) return [];
  const saved: SourceItem[] = [];
  for (const [index, asset] of result.assets.entries()) {
    saved.push(await addImageAsset(db, projectId, asset, `图片资料 ${index + 1}`));
  }
  return saved;
}

export async function captureAndAddImageSource(
  db: SQLiteDatabase,
  projectId: string,
): Promise<SourceItem | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('需要相机权限才能拍摄资料');
  const result = await ImagePicker.launchCameraAsync({ quality: 1 });
  if (result.canceled) return null;
  return addImageAsset(db, projectId, result.assets[0], '拍摄资料');
}

export async function addTextSource(
  db: SQLiteDatabase,
  projectId: string,
  title: string,
  text: string,
) {
  const clean = text.trim();
  if (!clean) throw new Error('先粘贴要保存的文字资料');
  assertByteLimit(utf8ByteLength(clean), MAX_TEXT_BYTES, '文字资料');
  const segments = await createTextSegments(clean);
  const contentHash = await digest(clean);
  return addProjectSourceItem(db, {
    projectId,
    kind: 'text',
    title: title.trim() || '粘贴资料',
    originalName: null,
    mediaType: 'text/plain',
    assetUri: null,
    sourceUrl: null,
    contentHash,
    byteSize: utf8ByteLength(clean),
    segments,
  });
}

export async function fetchWebSourcePreview(inputUrl: string): Promise<WebSourcePreview> {
  let currentUrl = normalizePublicWebUrl(inputUrl);
  const requestedUrl = currentUrl;
  for (let redirectCount = 0; redirectCount <= MAX_WEB_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html, text/plain, text/markdown;q=0.9',
          'User-Agent': 'LearnStuff/2 Android source preview',
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('网页读取超时');
      throw new Error('无法读取这个公开网页；请检查链接是否需要登录');
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('网页重定向缺少目标地址');
      if (redirectCount === MAX_WEB_REDIRECTS) throw new Error('网页重定向次数过多');
      currentUrl = normalizePublicWebUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
    const mediaType = (response.headers.get('content-type') ?? 'text/html').split(';')[0].trim().toLowerCase();
    if (!['text/html', 'text/plain', 'text/markdown'].includes(mediaType)) {
      throw new Error(`暂不支持这种网页内容类型：${mediaType || '未知'}`);
    }
    const declaredBytes = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > 0) {
      assertByteLimit(declaredBytes, MAX_WEB_BYTES, '网页');
    }
    const raw = await response.text();
    const byteSize = utf8ByteLength(raw);
    assertByteLimit(byteSize, MAX_WEB_BYTES, '网页');
    const text = mediaType === 'text/html' ? extractReadableHtml(raw) : raw.trim();
    if (text.length < 40) {
      throw new Error('网页没有读取到足够正文；若它需要登录或 JavaScript，请导出为 PDF/Markdown 后导入');
    }
    return {
      requestedUrl,
      finalUrl: currentUrl,
      title: mediaType === 'text/html' ? extractHtmlTitle(raw) || hostnameTitle(currentUrl) : hostnameTitle(currentUrl),
      mediaType,
      text: text.slice(0, 500_000),
      byteSize,
      truncated: text.length > 500_000,
    };
  }
  throw new Error('网页读取没有完成');
}

export async function addWebSource(
  db: SQLiteDatabase,
  projectId: string,
  preview: WebSourcePreview,
) {
  const segments = await createTextSegments(preview.text, 'url');
  const contentHash = await digest(`${preview.finalUrl}\n${preview.text}`);
  return addProjectSourceItem(db, {
    projectId,
    kind: 'web',
    title: preview.title,
    originalName: null,
    mediaType: preview.mediaType,
    assetUri: null,
    sourceUrl: preview.finalUrl,
    contentHash,
    byteSize: preview.byteSize,
    segments,
  });
}

async function addImageAsset(
  db: SQLiteDatabase,
  projectId: string,
  asset: ImagePicker.ImagePickerAsset,
  fallbackTitle: string,
) {
  const fileName = asset.fileName || `${fallbackTitle}.${extensionFromMime(asset.mimeType)}`;
  const mediaType = asset.mimeType || 'image/jpeg';
  try {
    assertByteLimit(asset.fileSize ?? 0, MAX_IMAGE_BYTES, '图片');
    if (asset.width * asset.height > 40_000_000) throw new Error('图片超过 4000 万像素安全上限');
    const text = (await ExpoContentExtractor.recognizeImageTextAsync(asset.uri)).trim();
    if (!text) throw new Error('这张图片没有识别到文字');
    const contentHash = await digest(text);
    const assetUri = await preserveSourceAsset(projectId, asset.uri, fileName, contentHash);
    return addProjectSourceItem(db, {
      projectId,
      kind: 'image',
      title: stripExtension(fileName) || fallbackTitle,
      originalName: fileName,
      mediaType,
      assetUri,
      sourceUrl: null,
      contentHash,
      byteSize: asset.fileSize ?? 0,
      segments: [{
        ordinal: 0,
        locatorType: 'image',
        locator: '图片 OCR',
        body: text,
        contentHash: await digest(text),
      }],
    });
  } catch (error) {
    return recordFailedProjectSourceItem(db, {
      projectId,
      kind: 'image',
      title: stripExtension(fileName) || fallbackTitle,
      originalName: fileName,
      mediaType,
      assetUri: null,
      sourceUrl: null,
      contentHash: await failedAssetHash(fileName, mediaType, asset.fileSize ?? 0, asset.uri),
      byteSize: asset.fileSize ?? 0,
      error: safeExtractionError(error),
    });
  }
}

async function createTextSegments(
  input: string,
  locatorType: 'paragraph' | 'url' = 'paragraph',
): Promise<NewSourceSegment[]> {
  const paragraphs = input
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs.length ? paragraphs : [input.trim()]) {
    if (current && current.length + paragraph.length + 2 > 4_000) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return Promise.all(chunks.map(async (body, index) => ({
    ordinal: index,
    locatorType,
    locator: locatorType === 'url' ? `网页片段 ${index + 1}` : `段落 ${index + 1}`,
    body,
    contentHash: await digest(body),
  })));
}

async function preserveSourceAsset(projectId: string, sourceUri: string, originalName: string, hash: string) {
  if (!FileSystem.documentDirectory) throw new Error('应用资料目录不可用');
  const directory = `${FileSystem.documentDirectory}sources/${safeFilePart(projectId)}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const destination = `${directory}${hash.slice(0, 16)}-${safeFilePart(originalName)}`;
  const info = await FileSystem.getInfoAsync(destination);
  if (!info.exists) await FileSystem.copyAsync({ from: sourceUri, to: destination });
  return destination;
}

async function failedAssetHash(name: string, mediaType: string, byteSize: number, uri: string) {
  return digest(`failed\n${name}\n${mediaType}\n${byteSize}\n${uri}`);
}

function safeExtractionError(error: unknown) {
  return error instanceof Error ? error.message : '设备端资料提取失败';
}

function extractReadableHtml(html: string) {
  return decodeHtmlEntities(html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|svg|canvas|nav|footer|header|form)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<(br|p|div|section|article|main|h[1-6]|li|tr)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function extractHtmlTitle(html: string) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/gu, ' ').trim().slice(0, 160) : '';
}

function decodeHtmlEntities(text: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function normalizeMediaType(mimeType: string | undefined, fileName: string) {
  const value = mimeType?.toLowerCase();
  if (value === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  if (value === 'text/markdown' || /\.(md|markdown)$/iu.test(fileName)) return 'text/markdown';
  return 'text/plain';
}

function stripExtension(value: string) {
  return value.replace(/\.[^.]+$/u, '').trim().slice(0, 160) || '未命名资料';
}

function extensionFromMime(value: string | undefined) {
  if (value === 'image/png') return 'png';
  if (value === 'image/webp') return 'webp';
  return 'jpg';
}

function hostnameTitle(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return '网页资料';
  }
}

function safeFilePart(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').trim().slice(0, 100) || 'source';
}

function assertByteLimit(actual: number, maximum: number, label: string) {
  if (actual > maximum) {
    throw new Error(`${label}超过 ${(maximum / 1_000_000).toFixed(0)} MB 安全上限`);
  }
}

function utf8ByteLength(text: string) {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function digest(value: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}
