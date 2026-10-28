import { normalizePublicWebUrl } from '@/ai/source-ingestion-policy';

export type PendingTextShare = {
  id: string;
  text: string;
  subject: string;
  mimeType: string;
  error: string | null;
  staged?: boolean;
  fileCount?: number;
  files?: PendingStagedFile[];
};

export type PendingStagedFile = {
  name: string;
  kind: 'pdf' | 'image' | 'markdown' | 'text';
  mediaType: string;
  byteSize: number;
  sha256: string;
  uri: string;
};

export type SharedTextPreview = {
  kind: 'text' | 'markdown' | 'web';
  title: string;
  text: string;
  sourceUrl: string | null;
  mediaType: string;
  byteSize: number;
};

export function utf8Size(text: string) {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function previewTextShare(input: PendingTextShare): SharedTextPreview {
  if (input.error) throw new Error(input.error);
  if (!['text/plain', 'text/markdown'].includes(input.mimeType)) throw new Error('暂不支持这种分享类型');
  const text = input.text.trim();
  if (!text) throw new Error('分享内容没有可保存的文字');
  const byteSize = utf8Size(text);
  if (byteSize > 8_000_000) throw new Error('分享文字超过 8 MB 上限');

  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const candidate = lines.length <= 3 ? lines.at(-1) ?? '' : '';
  let sourceUrl: string | null = null;
  if (/^https?:\/\//iu.test(candidate)) {
    try { sourceUrl = normalizePublicWebUrl(candidate); } catch { /* Save an unsupported URL as ordinary text. */ }
  }
  const kind = sourceUrl ? 'web' : input.mimeType === 'text/markdown' ? 'markdown' : 'text';
  const suggestedTitle = input.subject.trim()
    || (sourceUrl && lines.length > 1 ? lines[0] : '')
    || (sourceUrl ? new URL(sourceUrl).hostname : text.split(/\r?\n/u)[0]);
  const title = suggestedTitle.replace(/\s+/gu, ' ').trim().slice(0, 160) || '分享资料';
  return { kind, title, text, sourceUrl, mediaType: input.mimeType, byteSize };
}
