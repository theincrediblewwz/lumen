import type { BoardMeta, ProjectMeta, Viewport } from '../api';
import { clampZoom, IDENTITY_VIEWPORT, type Vec2 } from '../canvas/CanvasEngine';
import { pinnedFirst } from '../favorites';
import { EMPTY_COVERS, readCover, type CoverStore } from './covers';
import { assignedTags, type TagStore } from './tags';

export type ProjectRelation = { from: string; to: string; label?: string };

export type ProjectLayout = {
  version: 1;
  projects: Record<string, { parentId: string | null; position?: Vec2 }>;
  boards: Record<string, Record<string, Vec2>>;
  relations?: ProjectRelation[];
  tags?: TagStore;
};

export type ProjectLayoutSnapshot = { layout: ProjectLayout; scope: string; covers?: CoverStore; coverError?: string };

export const EMPTY_PROJECT_LAYOUT: ProjectLayout = { version: 1, projects: {}, boards: {} };
export const TILE_WIDTH = 154;
export const TILE_HEIGHT = 116;

export type CatalogTile = (
  | { kind: 'project'; row: ProjectMeta }
  | { kind: 'board'; row: BoardMeta }
) & { position: Vec2; favorite: boolean; tagIds: string[]; coverId?: string | null };

function own<T>(rows: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : undefined;
}

export function parentProject(layout: ProjectLayout, id: string) {
  return own(layout.projects, id)?.parentId ?? null;
}

export function projectPath(projects: ProjectMeta[], layout: ProjectLayout, projectId: string | null) {
  const available = new Map(projects.map(row => [row.id, row]));
  const trail: ProjectMeta[] = [];
  const seen = new Set<string>();
  while (projectId && !seen.has(projectId)) {
    const project = available.get(projectId);
    if (!project) break;
    trail.push(project);
    seen.add(projectId);
    projectId = parentProject(layout, projectId);
  }
  return trail.reverse();
}

export function catalogTiles(
  projects: ProjectMeta[],
  boards: BoardMeta[],
  layout: ProjectLayout,
  folderId: string | null,
  favorites: { projects: string[]; boards: string[] },
  covers: CoverStore = EMPTY_COVERS,
): CatalogTile[] {
  const folders = pinnedFirst(projects.filter(row => parentProject(layout, row.id) === folderId), favorites.projects);
  const boardPositions = folderId ? own(layout.boards, folderId) ?? {} : {};
  const items = [
    ...folders.map(row => ({
      kind: 'project' as const, row, position: own(layout.projects, row.id)?.position,
      favorite: favorites.projects.includes(row.id),
      tagIds: assignedTags(layout.tags, { kind: 'project', id: row.id }),
      coverId: readCover(covers, { kind: 'project', id: row.id }),
    })),
    ...pinnedFirst(folderId ? boards : [], favorites.boards).map(row => ({
      kind: 'board' as const, row, position: own(boardPositions, row.id),
      favorite: favorites.boards.includes(row.id),
      tagIds: assignedTags(layout.tags, { kind: 'board', projectId: folderId!, id: row.id }),
      coverId: readCover(covers, { kind: 'board', projectId: folderId!, id: row.id }),
    })),
  ].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  // The initial loose grid is stable across window sizes. Reserve the cells
  // touched by manually placed items before assigning a spot to new tiles.
  const left = 54, top = 66, stepX = 176, stepY = 150, columns = 4;
  const blocked = new Set<number>();
  const cell = (index: number) => ({
    x: left + (index % columns) * stepX,
    y: top + Math.floor(index / columns) * stepY + (index % 2 ? 28 : 0),
  });
  for (const { position } of items) {
    if (!position) continue;
    const firstRow = Math.max(0, Math.floor((position.y - top - TILE_HEIGHT - 28) / stepY));
    const lastRow = Math.max(firstRow, Math.ceil((position.y - top + TILE_HEIGHT) / stepY));
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        const point = cell(index);
        if (Math.abs(point.x - position.x) < TILE_WIDTH && Math.abs(point.y - position.y) < TILE_HEIGHT) {
          blocked.add(index);
        }
      }
    }
  }
  let next = 0;
  return items.map(item => {
    if (item.position) return { ...item, position: item.position };
    while (blocked.has(next)) next++;
    return { ...item, position: cell(next++) };
  });
}

function viewKey(scope: string, folderId: string | null) {
  return `lumen.projectCanvas.view.v1:${scope}:${folderId ?? '/'}`;
}

export function readProjectView(scope: string, folderId: string | null): Viewport {
  try {
    const view = JSON.parse(localStorage.getItem(viewKey(scope, folderId)) ?? 'null');
    if (view && Number.isFinite(view.x) && Number.isFinite(view.y)) {
      return { x: view.x, y: view.y, zoom: clampZoom(view.zoom, 0.15, 2.5) };
    }
  } catch { /* preferences can be unavailable */ }
  return { ...IDENTITY_VIEWPORT };
}

export function saveProjectView(scope: string, folderId: string | null, view: Viewport) {
  try { localStorage.setItem(viewKey(scope, folderId), JSON.stringify(view)); }
  catch { /* the saved tile positions do not depend on view preferences */ }
}
