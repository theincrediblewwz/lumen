import catalog from './covers.json';

export type CoverPreset = { id: string; name: string } & ({ kind: 'style' } | { kind: 'photo'; url: string });

const images = import.meta.glob<string>('./cover-images/*.jpg', { eager: true, query: '?url', import: 'default' });
export const COVER_PRESETS: CoverPreset[] = catalog.map(({ id, name, style }) => style
  ? { id, name, kind: 'style' }
  : { id, name, kind: 'photo', url: images[`./cover-images/${id}.jpg`] });
const presetsById = new Map(COVER_PRESETS.map(cover => [cover.id, cover]));

export function coverPreset(id?: string | null) {
  return id ? presetsById.get(id) : undefined;
}
