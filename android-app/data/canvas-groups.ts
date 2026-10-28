import type { SQLiteDatabase } from 'expo-sqlite';
import { newLocalId } from './conversations';

export type CanvasGroup = { id: string; project_id: string; title: string; created_at: string; updated_at: string };
export type CanvasGroupMember = { id: string; project_id: string; group_id: string; node_id: string; created_at: string };
type NodePosition = { id: string; x: number; y: number };
type Snapshot = { groups: CanvasGroup[]; members: CanvasGroupMember[]; positions: NodePosition[] };
export type CanvasGroupUndo = { projectId: string; before: Snapshot; after: Snapshot };

async function snapshot(db: SQLiteDatabase, projectId: string): Promise<Snapshot> {
  const [groups, members, positions] = await Promise.all([
    db.getAllAsync<CanvasGroup>('SELECT * FROM canvas_groups WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<CanvasGroupMember>('SELECT * FROM canvas_group_members WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<NodePosition>('SELECT id,x,y FROM nodes WHERE project_id=? ORDER BY id', projectId),
  ]);
  return { groups, members, positions };
}

export async function listCanvasGroups(db: SQLiteDatabase, projectId: string) {
  const [groups, members] = await Promise.all([
    db.getAllAsync<CanvasGroup>('SELECT * FROM canvas_groups WHERE project_id=? ORDER BY id', projectId),
    db.getAllAsync<CanvasGroupMember>('SELECT * FROM canvas_group_members WHERE project_id=? ORDER BY id', projectId),
  ]);
  return { groups, members };
}

async function mutate(db: SQLiteDatabase, projectId: string, change: (tx: SQLiteDatabase) => Promise<void>): Promise<CanvasGroupUndo> {
  let result: CanvasGroupUndo | null = null;
  await db.withExclusiveTransactionAsync(async tx => {
    const before = await snapshot(tx, projectId);
    await change(tx);
    result = { projectId, before, after: await snapshot(tx, projectId) };
  });
  return result!;
}

function titleValue(title: string) {
  const value = title.trim();
  if (!value || value.length > 80) throw new Error('分组名称需为 1–80 字');
  return value;
}

export async function createCanvasGroup(db: SQLiteDatabase, projectId: string, title: string, nodeIds: string[]) {
  const name = titleValue(title);
  const unique = [...new Set(nodeIds)];
  if (unique.length < 2 || unique.length !== nodeIds.length) throw new Error('请至少选择两个不同的节点');
  const groupId = newLocalId('group');
  const undo = await mutate(db, projectId, async tx => {
    const nodes = await tx.getAllAsync<{ id: string }>(`SELECT id FROM nodes WHERE project_id=? AND id IN (${unique.map(() => '?').join(',')})`, projectId, ...unique);
    if (nodes.length !== unique.length) throw new Error('选中的节点已不存在');
    const assigned = await tx.getFirstAsync('SELECT 1 FROM canvas_group_members WHERE node_id IN (' + unique.map(() => '?').join(',') + ') LIMIT 1', ...unique);
    if (assigned) throw new Error('选中的节点已经属于其他分组，请先移出');
    const now = new Date().toISOString();
    await tx.runAsync('INSERT INTO canvas_groups VALUES(?,?,?,?,?)', groupId, projectId, name, now, now);
    for (const nodeId of unique) await tx.runAsync('INSERT INTO canvas_group_members VALUES(?,?,?,?,?)', nodeId, projectId, groupId, nodeId, now);
  });
  return { groupId, undo };
}

export async function renameCanvasGroup(db: SQLiteDatabase, projectId: string, groupId: string, title: string) {
  const name = titleValue(title);
  return mutate(db, projectId, async tx => {
    const result = await tx.runAsync('UPDATE canvas_groups SET title=?,updated_at=? WHERE id=? AND project_id=?', name, new Date().toISOString(), groupId, projectId);
    if (result.changes !== 1) throw new Error('分组已不存在');
  });
}

export async function addCanvasGroupMember(db: SQLiteDatabase, projectId: string, groupId: string, nodeId: string) {
  return mutate(db, projectId, async tx => {
    const group = await tx.getFirstAsync('SELECT 1 FROM canvas_groups WHERE id=? AND project_id=?', groupId, projectId);
    const node = await tx.getFirstAsync('SELECT 1 FROM nodes WHERE id=? AND project_id=?', nodeId, projectId);
    if (!group || !node) throw new Error('分组或节点已不存在');
    const assigned = await tx.getFirstAsync('SELECT 1 FROM canvas_group_members WHERE node_id=?', nodeId);
    if (assigned) throw new Error('节点已属于分组，请先移出');
    const now = new Date().toISOString();
    await tx.runAsync('INSERT INTO canvas_group_members VALUES(?,?,?,?,?)', nodeId, projectId, groupId, nodeId, now);
    await tx.runAsync('UPDATE canvas_groups SET updated_at=? WHERE id=?', now, groupId);
  });
}

export async function removeCanvasGroupMember(db: SQLiteDatabase, projectId: string, groupId: string, nodeId: string) {
  return mutate(db, projectId, async tx => {
    const result = await tx.runAsync('DELETE FROM canvas_group_members WHERE id=? AND group_id=? AND project_id=?', nodeId, groupId, projectId);
    if (result.changes !== 1) throw new Error('节点不再属于此分组');
    const remains = await tx.getFirstAsync('SELECT 1 FROM canvas_group_members WHERE group_id=? LIMIT 1', groupId);
    if (remains) await tx.runAsync('UPDATE canvas_groups SET updated_at=? WHERE id=?', new Date().toISOString(), groupId);
    else await tx.runAsync('DELETE FROM canvas_groups WHERE id=? AND project_id=?', groupId, projectId);
  });
}

export async function deleteCanvasGroup(db: SQLiteDatabase, projectId: string, groupId: string) {
  return mutate(db, projectId, async tx => {
    await tx.runAsync('DELETE FROM canvas_group_members WHERE group_id=? AND project_id=?', groupId, projectId);
    const result = await tx.runAsync('DELETE FROM canvas_groups WHERE id=? AND project_id=?', groupId, projectId);
    if (result.changes !== 1) throw new Error('分组已不存在');
  });
}

export async function moveCanvasGroup(db: SQLiteDatabase, projectId: string, groupId: string, deltaX: number, deltaY: number) {
  if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) < 1_000_000)) throw new Error('分组移动距离无效');
  return mutate(db, projectId, async tx => {
    const rows = await tx.getAllAsync<NodePosition>('SELECT n.id,n.x,n.y FROM nodes n JOIN canvas_group_members m ON m.node_id=n.id WHERE m.group_id=? AND m.project_id=? ORDER BY n.id', groupId, projectId);
    if (!rows.length) throw new Error('分组已为空或不存在');
    for (const row of rows) {
      const x = row.x + deltaX; const y = row.y + deltaY;
      if (Math.abs(x) >= 1_000_000 || Math.abs(y) >= 1_000_000) throw new Error('节点移出了白板允许的范围');
      await tx.runAsync('UPDATE nodes SET x=?,y=? WHERE id=? AND project_id=?', x, y, row.id, projectId);
    }
  });
}

/** One-step undo refuses stale state, including edits received from another device. */
export async function undoCanvasGroupChange(db: SQLiteDatabase, undo: CanvasGroupUndo) {
  await db.withExclusiveTransactionAsync(async tx => {
    const current = await snapshot(tx, undo.projectId);
    if (JSON.stringify(current) !== JSON.stringify(undo.after)) throw new Error('分组或节点已在别处变化，请先查看最新白板；本次撤销没有覆盖新内容');
    const beforeGroups = new Map(undo.before.groups.map(row => [row.id, row]));
    const afterGroups = new Map(undo.after.groups.map(row => [row.id, row]));
    const beforeMembers = new Map(undo.before.members.map(row => [row.id, row]));
    const afterMembers = new Map(undo.after.members.map(row => [row.id, row]));
    for (const row of undo.after.members) if (JSON.stringify(beforeMembers.get(row.id)) !== JSON.stringify(row)) await tx.runAsync('DELETE FROM canvas_group_members WHERE id=?', row.id);
    for (const row of undo.after.groups) if (!beforeGroups.has(row.id)) await tx.runAsync('DELETE FROM canvas_groups WHERE id=?', row.id);
    for (const row of undo.before.groups) {
      if (!afterGroups.has(row.id)) await tx.runAsync('INSERT INTO canvas_groups VALUES(?,?,?,?,?)', row.id, row.project_id, row.title, row.created_at, row.updated_at);
      else if (JSON.stringify(afterGroups.get(row.id)) !== JSON.stringify(row)) await tx.runAsync('UPDATE canvas_groups SET title=?,updated_at=? WHERE id=?', row.title, row.updated_at, row.id);
    }
    for (const row of undo.before.members) if (JSON.stringify(afterMembers.get(row.id)) !== JSON.stringify(row)) await tx.runAsync('INSERT INTO canvas_group_members VALUES(?,?,?,?,?)', row.id, row.project_id, row.group_id, row.node_id, row.created_at);
    const afterPositions = new Map(undo.after.positions.map(row => [row.id, row]));
    for (const row of undo.before.positions) {
      const later = afterPositions.get(row.id);
      if (later && (row.x !== later.x || row.y !== later.y)) await tx.runAsync('UPDATE nodes SET x=?,y=? WHERE id=? AND project_id=?', row.x, row.y, row.id, undo.projectId);
    }
  });
}
