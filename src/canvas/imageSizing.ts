import type { BoardNode, DocRef } from '../api';
import { contentDocs, imageDoc } from './composition';
import { imageDisplaySize } from './presentation';
import { materialImageSize } from './preview';

export type ImagePixels = { width: number; height: number };
export type ImageDisplay = { width: number; pixelWidth: number; pixelHeight: number; resized?: boolean };

const REFRESH_INTERVAL = 60_000;
const MAX_LEGACY_IMAGES = 8;

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function imageDisplay(doc?: DocRef): ImageDisplay | undefined {
  const display = doc?.imageDisplay;
  if (display && positive(display.width) && positive(display.pixelWidth) && positive(display.pixelHeight)) return display;
}

export function imageDisplayAt(width: number, pixels: ImagePixels, resized = false): ImageDisplay {
  return { width, pixelWidth: pixels.width, pixelHeight: pixels.height, resized };
}

export function boardImageSizing(scope: string, projectId: string, boardId: string, readPixels: (path: string) => Promise<ImagePixels>) {
  const key = `lumen.image-sizing.v1.${JSON.stringify([scope, projectId, boardId])}`;
  let habit: { ratio: number; at: number } | undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && positive(saved.ratio) && Number.isFinite(saved.at)) habit = saved;
  } catch { /* a storage error should never prevent pasting an image */ }

  let lastAttempt = habit?.at ?? -Infinity;
  let refreshing: Promise<void> | undefined;
  const observed = new Map<string, ImagePixels>();

  const observe = (path: string, pixels: ImagePixels) => {
    if (!positive(pixels.width) || !positive(pixels.height)) return;
    observed.delete(path);
    observed.set(path, pixels);
    if (observed.size > 256) observed.delete(observed.keys().next().value!);
  };

  const refresh = async (nodes: BoardNode[], resized: ImageDisplay[]) => {
    const ratios = resized.map(display => display.width / display.pixelWidth);
    const defaults: number[] = [];
    const legacy = nodes.flatMap(node => {
      const primary = contentDocs(node)[0];
      return !node.flowOwnerId && primary && imageDoc(primary) && !imageDisplay(primary) && positive(node.w)
        ? [{ path: primary.path, width: node.w }] : [];
    });
    const count = Math.min(legacy.length, MAX_LEGACY_IMAGES);
    const samples = Array.from({ length: count }, (_, i) => legacy[Math.floor(i * legacy.length / count)]);
    for (const { path, width } of samples) {
      const pixels = observed.get(path) ?? await readPixels(path).catch(() => undefined);
      if (!pixels || !positive(pixels.width) || !positive(pixels.height)) continue;
      observe(path, pixels);
      const automatic = imageDisplaySize(pixels.width, pixels.height).w;
      const values = Math.abs(width - automatic) < 1 ? defaults : ratios;
      values.push(width / pixels.width);
    }
    const source = (ratios.length ? ratios : defaults).filter(positive);
    if (!source.length) return;
    habit = { ratio: source.reduce((sum, ratio) => sum + ratio, 0) / source.length, at: Date.now() };
    try { localStorage.setItem(key, JSON.stringify(habit)); } catch { /* retain the in-memory average */ }
  };

  return {
    observe,
    async suggest(nodes: BoardNode[], pixels: ImagePixels, attachment: boolean): Promise<ImageDisplay> {
      if (refreshing) await refreshing;
      else {
        const resized = nodes.flatMap(node => node.docs.flatMap(doc => {
          const display = imageDisplay(doc);
          return display?.resized && imageDoc(doc) ? [display] : [];
        }));
        if (Date.now() - lastAttempt >= REFRESH_INTERVAL || (!habit && resized.length)) {
          lastAttempt = Date.now();
          refreshing = refresh(nodes, resized).finally(() => { refreshing = undefined; });
          await refreshing;
        }
      }
      const fallback = attachment ? materialImageSize : imageDisplaySize;
      if (!habit) return imageDisplayAt(fallback(pixels.width, pixels.height).w, pixels);
      const longest = Math.max(pixels.width, pixels.height);
      const scale = Math.min(2400 / longest, Math.max(64 / longest, habit.ratio));
      return imageDisplayAt(pixels.width * scale, pixels);
    },
  };
}
