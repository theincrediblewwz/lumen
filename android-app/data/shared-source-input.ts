import * as Crypto from 'expo-crypto';

import type { SharedTextPreview } from '@/data/share-intake';
import type { NewSourceItem } from '@/data/source-items';

export async function buildSharedSourceInput(
  projectId: string,
  preview: SharedTextPreview,
  title: string,
): Promise<NewSourceItem> {
  const body = preview.sourceUrl
    ? `${preview.text}\n\n> 此处只保存了分享文字和链接，尚未提取网页正文。`
    : preview.text;
  const fingerprint = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `share:${preview.kind}\n${preview.sourceUrl ?? ''}\n${preview.text}`,
  );
  const segmentHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, body);
  return {
    projectId,
    kind: preview.kind,
    title: title.trim(),
    originalName: null,
    mediaType: preview.mediaType,
    assetUri: null,
    sourceUrl: preview.sourceUrl,
    contentHash: fingerprint,
    byteSize: preview.byteSize,
    segments: [{
      ordinal: 0,
      locatorType: preview.sourceUrl ? 'url' : 'text',
      locator: preview.sourceUrl ?? '分享文字',
      body,
      contentHash: segmentHash,
    }],
  };
}
