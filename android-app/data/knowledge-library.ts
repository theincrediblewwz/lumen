import type { SQLiteDatabase } from 'expo-sqlite';
import { emptyKnowledgeLibrary, knowledgeId, knowledgeTerms, resolveKnowledgeReferences, saveKnowledgeInLibrary,
  validateKnowledgeLibrary, copyKnowledgeLibrary, type KnowledgeLibrary, type KnowledgeEntry, type KnowledgeRevision,
  type KnowledgeBinding, type KnowledgeSetting, type KnowledgePolicy } from './knowledge-library-core';

export async function loadKnowledgeLibrary(db: SQLiteDatabase): Promise<KnowledgeLibrary> {
  if (!(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_entries'"))) return emptyKnowledgeLibrary();
  return { version: 1,
    entries: await db.getAllAsync<KnowledgeEntry>('SELECT * FROM knowledge_entries ORDER BY updated_at DESC,id'),
    revisions: await db.getAllAsync<KnowledgeRevision>('SELECT * FROM knowledge_revisions ORDER BY created_at,id'),
    bindings: await db.getAllAsync<KnowledgeBinding>('SELECT * FROM knowledge_bindings ORDER BY id'),
    settings: await db.getAllAsync<KnowledgeSetting>('SELECT * FROM knowledge_reference_settings ORDER BY id') };
}
export async function saveKnowledgeEntry(db: SQLiteDatabase, input: Parameters<typeof saveKnowledgeInLibrary>[1]) {
  let saved: KnowledgeEntry | null = null;
  await db.withExclusiveTransactionAsync(async tx => {
    const { entry, library } = saveKnowledgeInLibrary(await loadKnowledgeLibrary(tx), input);
    await writeRows(tx, 'knowledge_entries', [entry]);
    await writeRows(tx, 'knowledge_revisions', library.revisions.filter(row => row.id === entry.revision_id));
    saved = entry;
  });
  return saved! as KnowledgeEntry;
}
export async function archiveKnowledgeEntry(db: SQLiteDatabase, id: string, archived: boolean, expectedRevision: string) {
  const result = await db.runAsync('UPDATE knowledge_entries SET archived=?,updated_at=? WHERE id=? AND revision_id=?',
    archived ? 1 : 0, new Date().toISOString(), id, expectedRevision);
  if (result.changes !== 1) throw new Error('知识已变化，请重新打开后归档');
}
export async function setKnowledgePolicy(db: SQLiteDatabase, projectId: string, policy: KnowledgePolicy) {
  if (!['disabled', 'allowed', 'priority'].includes(policy)) throw new Error('引用权限无效');
  await db.runAsync(`INSERT INTO knowledge_reference_settings(id,project_id,policy,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at`,
    projectId, projectId, policy, new Date().toISOString());
}
/** Small read model for the board's explicit authorization control; reading never grants access. */
export async function loadKnowledgeReferenceStatus(db: SQLiteDatabase, projectId: string) {
  const setting = await db.getFirstAsync<KnowledgeSetting>('SELECT * FROM knowledge_reference_settings WHERE project_id=?', projectId);
  const count = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(DISTINCT b.entry_id) AS count
    FROM knowledge_bindings b JOIN knowledge_entries e ON e.id=b.entry_id
    WHERE b.project_id=? AND e.archived=0`, projectId);
  return { policy: setting?.policy ?? 'disabled' as KnowledgePolicy, boundCount: count?.count ?? 0 };
}
export async function bindKnowledgeEntry(db: SQLiteDatabase, projectId: string, entryId: string, nodeId: string | null, enabled: boolean) {
  await db.withExclusiveTransactionAsync(async tx => {
    if (nodeId && !(await tx.getFirstAsync('SELECT id FROM nodes WHERE id=? AND project_id=?', nodeId, projectId))) throw new Error('引用节点不属于当前白板');
    const existing = await tx.getFirstAsync<{ id: string }>('SELECT id FROM knowledge_bindings WHERE project_id=? AND entry_id=? AND node_id IS ?', projectId, entryId, nodeId);
    if (enabled && !existing) await tx.runAsync('INSERT INTO knowledge_bindings(id,project_id,entry_id,node_id,created_at) VALUES(?,?,?,?,?)', knowledgeId('binding'), projectId, entryId, nodeId, new Date().toISOString());
    if (!enabled && existing) await tx.runAsync('DELETE FROM knowledge_bindings WHERE id=?', existing.id);
  });
}
/** Query at most 60 matching candidates plus all explicit bindings. No index rebuild or whole-library prompt. */
export async function loadKnowledgeReferences(db: SQLiteDatabase, projectId: string, question: string, options: Parameters<typeof resolveKnowledgeReferences>[3] = {}) {
  // Historical import/evaluation fixtures can still use the pre-library schema.
  if (!(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_reference_settings'"))) return [];
  const setting = await db.getFirstAsync<KnowledgeSetting>('SELECT * FROM knowledge_reference_settings WHERE project_id=?', projectId);
  if (!setting || setting.policy === 'disabled' || (options.sourceBound && !options.allowOutside)) return [];
  const bindings = await db.getAllAsync<KnowledgeBinding>('SELECT * FROM knowledge_bindings WHERE project_id=? AND (node_id IS NULL OR node_id IS ?)', projectId, options.nodeId ?? null);
  const pinned = bindings.length ? await db.getAllAsync<KnowledgeEntry>(`SELECT * FROM knowledge_entries WHERE id IN (${bindings.map(() => '?').join(',')})`, ...bindings.map(row => row.entry_id)) : [];
  const terms = knowledgeTerms(question);
  const patterns = terms.flatMap(term => { const pattern = `%${term.replace(/[\\%_]/gu, '\\$&')}%`; return [pattern, pattern]; });
  const matches = setting.policy === 'allowed' && terms.length ? await db.getAllAsync<KnowledgeEntry>(
    `SELECT * FROM knowledge_entries WHERE archived=0 AND (${terms.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(' OR ')}) ORDER BY updated_at DESC,id LIMIT 60`, ...patterns) : [];
  const entries = new Map([...pinned, ...matches].map(row => [row.id, row]));
  const visited = new Set<string>();
  while (true) {
    const ids = [...new Set([...entries.values()].flatMap(row => JSON.parse(row.basis_json) as string[]))].filter(id => !entries.has(id) && !visited.has(id));
    if (!ids.length) break;
    if (entries.size + ids.length > 120) throw new Error('相关材料依据过多，请减少指定条目后重试');
    ids.forEach(id => visited.add(id));
    for (const row of await db.getAllAsync<KnowledgeEntry>(`SELECT * FROM knowledge_entries WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) entries.set(row.id, row);
  }
  return resolveKnowledgeReferences({ ...emptyKnowledgeLibrary(), entries: [...entries.values()], bindings, settings: [setting] }, projectId, question, options);
}
export async function importKnowledgeLibrary(db: SQLiteDatabase, value: unknown, projectMap = new Map<string, string>(), nodeMap = new Map<string, string>()) {
  const { library, entryIds } = copyKnowledgeLibrary(value);
  const copied = mapKnowledgeBoards(library, projectMap, nodeMap);
  validateKnowledgeLibrary(copied);
  await writeKnowledgeLibraryRows(db, copied);
  return entryIds;
}
export function mapKnowledgeBoards(library: KnowledgeLibrary, projectMap: ReadonlyMap<string, string>, nodeMap: ReadonlyMap<string, string>): KnowledgeLibrary {
  return { ...library, bindings: library.bindings.filter(row => projectMap.has(row.project_id) && (!row.node_id || nodeMap.has(row.node_id))).map(row => ({ ...row, project_id: projectMap.get(row.project_id)!, node_id: row.node_id ? nodeMap.get(row.node_id)! : null })),
    settings: library.settings.filter(row => projectMap.has(row.project_id)).map(row => ({ ...row, id: projectMap.get(row.project_id)!, project_id: projectMap.get(row.project_id)! })) };
}
export async function writeKnowledgeLibraryRows(db: SQLiteDatabase, library: KnowledgeLibrary) {
  for (const [table, rows] of [['knowledge_entries', library.entries], ['knowledge_revisions', library.revisions],
    ['knowledge_bindings', library.bindings], ['knowledge_reference_settings', library.settings]] as const) await writeRows(db, table, rows);
}
async function writeRows(db: SQLiteDatabase, table: string, rows: readonly object[]) {
  const columns = (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(row => row.name);
  for (const row of rows) {
    const data = row as Record<string, string | number | null>;
    const keys = columns.filter(key => Object.hasOwn(data, key));
    await db.runAsync(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.filter(key => key !== 'id').map(key => `${key}=excluded.${key}`).join(',')}`, ...keys.map(key => data[key]));
  }
}
