export type PreviewPosition = { resource: number; page: number };
/** View-only navigation; neither source documents nor their order are changed. */
export function stepPreview(position: PreviewPosition, counts: number[], direction = 1): PreviewPosition {
  if (!counts.length) return { resource: 0, page: 0 };
  const resource = Math.max(0, Math.min(counts.length - 1, position.resource));
  const page = Math.max(0, Math.min(Math.max(1, counts[resource]) - 1, position.page));
  if (direction > 0) return page + 1 < counts[resource] ? { resource, page: page + 1 }
    : { resource: (resource + 1) % counts.length, page: 0 };
  if (page > 0) return { resource, page: page - 1 };
  const previous = (resource + counts.length - 1) % counts.length;
  return { resource: previous, page: Math.max(1, counts[previous]) - 1 };
}
/** High-resolution slides receive a larger, ratio-preserving canvas footprint. */
export function materialImageSize(width: number, height: number) {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || width <= 0 || height <= 0) return { w: 240, h: 240 };
  const scale = Math.min(1600, Math.max(160, longest)) / longest;
  return { w: width * scale, h: height * scale };
}
export function flowPanelWidth(value: number, available: number) {
  const max = Math.max(180, available - 32);
  return Math.min(max, Math.max(Math.min(280, max), value));
}
export function flowHighlight(color?: string | null): string {
  const hex = color?.replace(/^#/, '');
  if (!hex || !/^(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(hex)) return color ? `color-mix(in srgb, ${color} 65%, white)` : '#45ffb2';
  const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const hue = !d ? 155 : max === r ? ((g - b) / d + 6) % 6 * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return `hsl(${Math.round(hue)} 100% 65%)`;
}
