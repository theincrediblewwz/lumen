import type { SQLiteDatabase } from 'expo-sqlite';
import { clampCanvasScale } from '@/components/canvas-transform';

// Device-only presentation state. Knowledge and relations remain in the synced tables.
export type CanvasViewport = { centerX: number; centerY: number; scale: number };
export type CanvasState = { viewport: CanvasViewport | null; collapsedNodeIds: string[] };

type StateRow = { center_x: number | null; center_y: number | null; scale: number | null; collapsed_ids_json: string };
let boardOpenedThisProcess = false;
export function hasOpenedBoardThisProcess() { return boardOpenedThisProcess; }

export function validViewport(input: CanvasViewport | null | undefined): CanvasViewport | null {
  if (!input || ![input.centerX, input.centerY, input.scale].every(Number.isFinite) || input.scale <= 0) return null;
  return { centerX: input.centerX, centerY: input.centerY, scale: clampCanvasScale(input.scale) };
}

export async function getCanvasState(db: SQLiteDatabase, projectId: string): Promise<CanvasState> {
  const row = await db.getFirstAsync<StateRow>(
    'SELECT center_x,center_y,scale,collapsed_ids_json FROM local_canvas_state WHERE project_id=?', projectId,
  );
  if (!row) return { viewport: null, collapsedNodeIds: [] };
  let collapsedNodeIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.collapsed_ids_json);
    if (Array.isArray(parsed)) collapsedNodeIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch { /* Damaged presentation preferences must not block the board. */ }
  return {
    viewport: row.center_x === null || row.center_y === null || row.scale === null
      ? null : validViewport({ centerX: row.center_x, centerY: row.center_y, scale: row.scale }),
    collapsedNodeIds,
  };
}

export async function getRecentBoardId(db: SQLiteDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ project_id: string | null }>(
    'SELECT p.id AS project_id FROM local_canvas_recent r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=1',
  );
  return row?.project_id ?? null;
}

export async function rememberBoard(db: SQLiteDatabase, projectId: string): Promise<void> {
  boardOpenedThisProcess = true;
  await db.runAsync('INSERT INTO local_canvas_recent(id,project_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id', projectId);
  await db.runAsync('INSERT OR IGNORE INTO local_canvas_state(project_id) VALUES(?)', projectId);
}

export async function saveCanvasViewport(db: SQLiteDatabase, projectId: string, input: CanvasViewport): Promise<void> {
  const viewport = validViewport(input);
  if (!viewport) return;
  await db.runAsync(
    `INSERT INTO local_canvas_state(project_id,center_x,center_y,scale) VALUES(?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET center_x=excluded.center_x,center_y=excluded.center_y,scale=excluded.scale`,
    projectId, viewport.centerX, viewport.centerY, viewport.scale,
  );
}

export async function saveCollapsedNodes(db: SQLiteDatabase, projectId: string, ids: string[]): Promise<void> {
  await db.runAsync(
    `INSERT INTO local_canvas_state(project_id,collapsed_ids_json) VALUES(?,?)
     ON CONFLICT(project_id) DO UPDATE SET collapsed_ids_json=excluded.collapsed_ids_json`,
    projectId, JSON.stringify([...new Set(ids)]),
  );
}
