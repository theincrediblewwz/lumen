import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

import ExpoContentExtractor from '@/modules/expo-content-extractor';
import { utf8Size, type PendingStagedFile } from '@/data/share-intake';
import type { NewSourceItem, NewSourceSegment } from '@/data/source-items';

const MAX_BATCH_TEXT_BYTES = 1_000_000;

function assertStagedFile(file: PendingStagedFile) {
  const base = FileSystem.cacheDirectory;
  if (!base || !file.uri.startsWith(`${base}share-inbox/`) || /(?:^|\/)\.\.(?:\/|$)/u.test(decodeURIComponent(file.uri))) {
    throw new Error('分享暂存文件地址无效，请重新分享');
  }
  if (!/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) {
    throw new Error('分享文件校验信息无效');
  }
  const limit = file.kind === 'pdf' ? 32 * 1024 * 1024 : file.kind === 'image' ? 20_000_000 : 8_000_000;
  if (file.byteSize > limit) throw new Error(`${file.name} 超过可同步大小上限`);
}

async function segment(body: string, locatorType: NewSourceSegment['locatorType'], locator: string, ordinal: number): Promise<NewSourceSegment> {
  return {
    ordinal, locatorType, locator, body,
    contentHash: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, body),
  };
}

export async function prepareSharedFileInput(projectId: string, file: PendingStagedFile): Promise<NewSourceItem> {
  assertStagedFile(file);
  const title = file.name.replace(/\.[^.]+$/u, '').trim().slice(0, 160) || '分享文件';
  let segments: NewSourceSegment[] = [];
  if (file.kind === 'pdf') {
    let pages: Awaited<ReturnType<typeof ExpoContentExtractor.extractPdfPagesAsync>>;
    try { pages = await ExpoContentExtractor.extractPdfPagesAsync(file.uri); }
    catch { throw new Error(`${file.name} 无法解析或识别，请检查文件或重新导出 PDF；整批尚未保存`); }
    for (const page of pages) {
      if (page.text.trim()) segments.push(await segment(page.text.trim(), 'page', `第 ${page.page} 页`, segments.length));
    }
    if (!segments.length) throw new Error(`${file.name} 没有可保存的 PDF 文字；本批次尚未写入`);
  } else if (file.kind === 'image') {
    let text: string;
    try { text = (await ExpoContentExtractor.recognizeImageTextAsync(file.uri)).trim(); }
    catch { throw new Error(`${file.name} 图片文字识别失败，请确认图像清晰且不超过 4000 万像素；整批尚未保存`); }
    if (!text) throw new Error(`${file.name} 没有识别到文字；本批次尚未写入`);
    segments = [await segment(text, 'image', '图片 OCR', 0)];
  } else {
    let text: string;
    try { text = (await FileSystem.readAsStringAsync(file.uri)).trim(); }
    catch { throw new Error(`${file.name} 文字文件无法读取；整批尚未保存`); }
    if (!text) throw new Error(`${file.name} 没有可保存的文字；本批次尚未写入`);
    if (utf8Size(text) > 8_000_000) throw new Error(`${file.name} 超过文字大小上限`);
    const chunks = text.split(/\n{2,}/u).map(item => item.trim()).filter(Boolean);
    for (const chunk of chunks) segments.push(await segment(chunk, 'paragraph', `段落 ${segments.length + 1}`, segments.length));
  }
  return {
    projectId, kind: file.kind, title, originalName: file.name,
    mediaType: file.mediaType, assetUri: null, sourceUrl: null,
    contentHash: file.sha256, byteSize: file.byteSize, segments,
  };
}

export function assertShareBatchTextBudget(inputs: NewSourceItem[]) {
  const total = inputs.reduce((sum, input) => sum + input.segments.reduce((part, item) => part + utf8Size(item.body), 0), 0);
  if (total > MAX_BATCH_TEXT_BYTES) throw new Error('本批次提取文字超过可同步的 1 MB 上限，请分批分享');
}

export async function persistSharedFile(projectId: string, file: PendingStagedFile): Promise<string> {
  assertStagedFile(file);
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) throw new Error('应用资料目录不可用');
  const safeProject = projectId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 96);
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 96);
  const directory = `${documentDirectory}sources/${safeProject}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const destination = `${directory}share-${Crypto.randomUUID()}-${safeName || 'file'}`;
  try {
    await FileSystem.copyAsync({ from: file.uri, to: destination });
    const info = await FileSystem.getInfoAsync(destination);
    if (!info.exists || info.size !== file.byteSize) throw new Error('文件副本不完整，已停止保存');
    return destination;
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true });
    throw error;
  }
}

export async function discardPersistedSharedFiles(uris: string[]) {
  const base = FileSystem.documentDirectory;
  for (const uri of uris) {
    if (base && uri.startsWith(`${base}sources/`) && /\/share-[0-9a-f-]{36}-/u.test(uri)) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }
}
