import catalog from './covers.json';

export type CoverTarget = { kind: 'project'; id: string } | { kind: 'board'; projectId: string; id: string };
export type CoverStore = Record<string, string>;
export const EMPTY_COVERS: CoverStore = {};

const images = import.meta.glob<string>('./cover-images/*.jpg', { eager: true, query: '?url', import: 'default' });
export const COVER_PRESETS = catalog.map(cover => ({ ...cover, url: images[`./cover-images/${cover.id}.jpg`] }));
const presetsById = new Map(COVER_PRESETS.map(cover => [cover.id, cover]));

export function coverPreset(id?: string | null) {
  return id ? presetsById.get(id) : undefined;
}

export function coverKey(target: CoverTarget) {
  return target.kind === 'project' ? target.id : `${target.projectId}/${target.id}`;
}

export function readCover(covers: CoverStore, target: CoverTarget): string | null {
  const key = coverKey(target);
  return Object.prototype.hasOwnProperty.call(covers, key) ? covers[key] : null;
}
