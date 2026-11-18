export type CoverTarget = { kind: 'project'; id: string } | { kind: 'board'; projectId: string; id: string };
export type CoverStore = Record<string, string>;
export const EMPTY_COVERS: CoverStore = {};

export function coverKey(target: CoverTarget) {
  return target.kind === 'project' ? target.id : `${target.projectId}/${target.id}`;
}

export function readCover(covers: CoverStore, target: CoverTarget): string | null {
  const key = coverKey(target);
  return Object.prototype.hasOwnProperty.call(covers, key) ? covers[key] : null;
}
