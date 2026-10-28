import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from '../data/database';
import { addCanvasGroupMember, createCanvasGroup, deleteCanvasGroup, listCanvasGroups, moveCanvasGroup, removeCanvasGroupMember, renameCanvasGroup, undoCanvasGroupChange } from '../data/canvas-groups';
import { createFreeBoard, createManualNode } from '../data/node-workspace';

async function fixture() {
  const raw = new DatabaseSync(':memory:');
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (work: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE'); try { await work(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = api as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  const second = await createManualNode(db, { projectId: 'project-transformer', title: '第二个', body: '# 第二个' });
  const third = await createManualNode(db, { projectId: 'project-transformer', title: '第三个', body: '# 第三个' });
  return { raw, db, second, third };
}

test('group create, rename, add, remove, move, delete and one-step undo preserve node content', async t => {
  const { raw, db, second, third } = await fixture(); t.after(() => raw.close());
  const originalNodes = raw.prepare('SELECT id,title,document_id FROM nodes ORDER BY id').all();
  const beforeBackup = (raw.prepare('SELECT revision FROM local_backup_jobs').get() as { revision: number }).revision;
  const created = await createCanvasGroup(db, 'project-transformer', ' 基础 ', ['node-transformer', second]);
  let state = await listCanvasGroups(db, 'project-transformer');
  assert.equal(state.groups[0].title, '基础'); assert.equal(state.members.length, 2);
  assert.ok((raw.prepare('SELECT revision FROM local_backup_jobs').get() as { revision: number }).revision > beforeBackup);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM sync_changes WHERE kind IN ('canvas_groups','canvas_group_members')").get() as { n: number }).n, 3);
  await undoCanvasGroupChange(db, created.undo);
  assert.deepEqual(await listCanvasGroups(db, 'project-transformer'), { groups: [], members: [] });

  const again = await createCanvasGroup(db, 'project-transformer', '基础', ['node-transformer', second]);
  const renamed = await renameCanvasGroup(db, 'project-transformer', again.groupId, '重点');
  assert.equal((await listCanvasGroups(db, 'project-transformer')).groups[0].title, '重点');
  await undoCanvasGroupChange(db, renamed);
  const added = await addCanvasGroupMember(db, 'project-transformer', again.groupId, third);
  assert.equal((await listCanvasGroups(db, 'project-transformer')).members.length, 3);
  await undoCanvasGroupChange(db, added);
  const removed = await removeCanvasGroupMember(db, 'project-transformer', again.groupId, second);
  assert.equal((await listCanvasGroups(db, 'project-transformer')).members.length, 1);
  await undoCanvasGroupChange(db, removed);
  const before = raw.prepare('SELECT id,x,y FROM nodes ORDER BY id').all();
  const moved = await moveCanvasGroup(db, 'project-transformer', again.groupId, 47, -32);
  assert.equal((raw.prepare('SELECT x FROM nodes WHERE id=?').get(third) as { x: number }).x, (before.find((row: any) => row.id === third) as any).x);
  await undoCanvasGroupChange(db, moved);
  assert.deepEqual(raw.prepare('SELECT id,x,y FROM nodes ORDER BY id').all(), before);
  const deleted = await deleteCanvasGroup(db, 'project-transformer', again.groupId);
  assert.deepEqual(await listCanvasGroups(db, 'project-transformer'), { groups: [], members: [] });
  await undoCanvasGroupChange(db, deleted);
  state = await listCanvasGroups(db, 'project-transformer'); assert.equal(state.members.length, 2);
  assert.deepEqual(raw.prepare('SELECT id,title,document_id FROM nodes ORDER BY id').all(), originalNodes);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
});

test('stale undo, duplicate membership and cross-board member are rejected without mutation', async t => {
  const { raw, db, second, third } = await fixture(); t.after(() => raw.close());
  const created = await createCanvasGroup(db, 'project-transformer', '第一组', ['node-transformer', second]);
  await assert.rejects(addCanvasGroupMember(db, 'project-transformer', created.groupId, second), /已属于分组/);
  const other = await createFreeBoard(db, '另一块白板', '# 内容');
  assert.throws(() => raw.prepare('INSERT INTO canvas_group_members VALUES(?,?,?,?,?)').run(other.nodeId, other.projectId, created.groupId, other.nodeId, 'now'), /跨图谱/);
  const moved = await moveCanvasGroup(db, 'project-transformer', created.groupId, 50, 0);
  raw.prepare('UPDATE nodes SET x=x+7 WHERE id=?').run(second);
  await assert.rejects(undoCanvasGroupChange(db, moved), /已在别处变化/);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM canvas_group_members').get() as { n: number }).n, 2);
  assert.ok(raw.prepare('SELECT id FROM nodes WHERE id=?').get(third));
});
