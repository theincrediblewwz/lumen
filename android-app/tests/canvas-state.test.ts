import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { getCanvasState, getRecentBoardId, rememberBoard, saveCanvasViewport, saveCollapsedNodes, validViewport } from '../data/canvas-state';

test('local viewport survives restart, clamps zoom, and deleted recent board safely falls back', async t => {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const adapter = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (action: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try { await action(adapter as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = adapter as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  raw.exec('PRAGMA foreign_keys=ON');
  const project = raw.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
  assert.equal(await getRecentBoardId(db), null);
  await rememberBoard(db, project.id);
  await saveCanvasViewport(db, project.id, { centerX: 120.5, centerY: -31, scale: 0.8 });
  await saveCollapsedNodes(db, project.id, ['node-a', 'node-a', 'node-b']);
  assert.equal(await getRecentBoardId(db), project.id);
  assert.deepEqual(await getCanvasState(db, project.id), {
    viewport: { centerX: 120.5, centerY: -31, scale: 0.8 }, collapsedNodeIds: ['node-a','node-b'],
  });
  assert.equal(validViewport({ centerX: Infinity, centerY: 0, scale: 1 }), null);
  await saveCanvasViewport(db, project.id, { centerX: 0, centerY: 0, scale: 100 });
  assert.equal((await getCanvasState(db, project.id)).viewport?.scale, 1.35);
  assert.deepEqual(raw.prepare('SELECT * FROM sync_changes WHERE kind LIKE ?').all('local_canvas%'), []);
  raw.prepare('DELETE FROM projects WHERE id=?').run(project.id);
  assert.equal(await getRecentBoardId(db), null);
  assert.deepEqual(raw.prepare('SELECT * FROM local_canvas_state').all(), []);
});
