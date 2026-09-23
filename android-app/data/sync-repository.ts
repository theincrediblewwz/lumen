import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson, createSyncState, entityKey, getConflicts, parseSyncState, queueLocalChanges } from '../sync/core';
import type { BlobRef, LocalChange, Sha256, SyncApplication, SyncCommit, SyncConflict, SyncEntity, SyncState } from '../sync/core/types';
import { SYNC_PRIMARY_KEYS, SYNC_TABLES, syncIdSql, type SyncTable } from './sync-schema';

type Row = Record<string, unknown>;
type Dirty = { kind: SyncTable; entity_id: string; revision: number };
export type SyncSettings = {
  endpoint: string; library_id: string; enabled: number; consented_at: string | null;
  device_id: string; status: string; last_success_at: string | null; last_error: string | null;
  background_error: string | null; last_attempt_at: string | null;
};
export interface SyncAssets {
  exportFile(uri: string, mediaType: string): Promise<BlobRef>;
  install(ref: BlobRef, bytes: Uint8Array): Promise<string>;
  localUri(ref: BlobRef): Promise<string>;
}
export const getSyncSettings = (db: SQLiteDatabase) => db.getFirstAsync<SyncSettings>('SELECT * FROM sync_settings WHERE id=1');

export async function acquireSyncLease(db: SQLiteDatabase, owner: string, now = Date.now()) {
  const result = await db.runAsync('UPDATE sync_control SET lease_owner=?,lease_expires_at=? WHERE id=1 AND (lease_owner IS NULL OR lease_expires_at<?)', owner, now + 180_000, now);
  return result.changes === 1;
}
export async function releaseSyncLease(db: SQLiteDatabase, owner: string) {
  await db.runAsync('UPDATE sync_control SET lease_owner=NULL,lease_expires_at=NULL WHERE id=1 AND lease_owner=?', owner);
}
async function requireIdle(tx: SQLiteDatabase) {
  if (await tx.getFirstAsync('SELECT 1 FROM sync_control WHERE lease_owner IS NOT NULL AND lease_expires_at>=?', Date.now())) throw new Error('同步正在完成，请稍后再修改设置或选择版本');
}

export async function loadSyncState(db: SQLiteDatabase): Promise<SyncState | null> {
  const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM sync_state WHERE id=1');
  return row ? JSON.parse(row.body) as SyncState : null;
}

export async function saveSyncConfiguration(db: SQLiteDatabase, input: { endpoint: string; libraryId: string; deviceId: string; consent: boolean }) {
  const url = new URL(input.endpoint.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('同步地址必须是无内嵌密码的 HTTPS WebDAV 文件夹地址');
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(input.libraryId)) throw new Error('资料库名称只能使用英文字母、数字、短横线和下划线');
  if (!input.consent) throw new Error('请先确认向自己的 WebDAV 服务同步全部学习内容和原始附件');
  const endpoint = url.toString().replace(/\/+$/, '');
  await db.withExclusiveTransactionAsync(async (tx) => {
    await requireIdle(tx);
    const current = await getSyncSettings(tx);
    const state = await loadSyncState(tx);
    if (state && (state.libraryId !== input.libraryId || current?.endpoint !== endpoint)) {
      throw new Error('此设备已绑定资料库。为保护现有同步历史，请继续使用原地址和资料库；迁移服务需要单独的数据迁移流程');
    }
    if (!state) await saveState(tx, createSyncState(input.libraryId, input.deviceId));
    await tx.runAsync(`UPDATE sync_settings SET endpoint=?,library_id=?,device_id=?,enabled=1,consented_at=?,status='pending',last_error=NULL WHERE id=1`,
      endpoint, input.libraryId, state?.deviceId ?? input.deviceId, new Date().toISOString());
  });
}

export async function pauseSync(db: SQLiteDatabase) {
  await db.runAsync("UPDATE sync_settings SET enabled=0,status='paused' WHERE id=1");
}

async function saveState(tx: SQLiteDatabase, state: SyncState) {
  await tx.runAsync('INSERT INTO sync_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(state));
  const conflicts = getConflicts(state);
  await tx.runAsync('UPDATE sync_conflicts SET resolved_at=? WHERE resolved_at IS NULL', new Date().toISOString());
  for (const conflict of conflicts) {
    await tx.runAsync('INSERT INTO sync_conflicts(id,body,resolved_at) VALUES(?,?,NULL) ON CONFLICT(id) DO UPDATE SET body=excluded.body,resolved_at=NULL', conflict.key, JSON.stringify(conflict));
  }
}

export async function listSyncConflicts(db: SQLiteDatabase) {
  return (await db.getAllAsync<{ body: string }>('SELECT body FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY id'))
    .map((row) => JSON.parse(row.body) as SyncConflict);
}

export type BlockedSync = { id: string; reason: string; created_at: string; resolved_at: string | null; commit: SyncCommit; localEntities: SyncEntity[] };
export async function listBlockedSync(db: SQLiteDatabase): Promise<BlockedSync[]> {
  const rows = await db.getAllAsync<{ id: string; body: string; reason: string; created_at: string; resolved_at: string | null }>('SELECT * FROM sync_blocked_inbound ORDER BY resolved_at IS NULL DESC,created_at DESC');
  return rows.map((row) => {
    const stored = JSON.parse(row.body) as { commit: SyncCommit; localEntities?: SyncEntity[] };
    return { id: row.id, reason: row.reason, created_at: row.created_at, resolved_at: row.resolved_at, commit: stored.commit, localEntities: stored.localEntities ?? [] };
  });
}

async function boardFor(tx: SQLiteDatabase, kind: SyncTable, row: Row): Promise<string | null> {
  if (kind === 'projects') return String(row.id);
  if (typeof row.project_id === 'string') return row.project_id;
  const links: Record<string, [string, string]> = {
    source_segments: ['source_items', 'source_item_id'], conversation_messages: ['conversations', 'conversation_id'],
    reading_positions: ['documents', 'document_id'], node_documents: ['nodes', 'node_id'],
    conversation_documents: ['documents', 'document_id'], favorite_bindings: ['favorites', 'favorite_id'],
  };
  const link = links[kind];
  if (!link) return null;
  const parent = await tx.getFirstAsync<{ project_id: string }>(`SELECT project_id FROM ${link[0]} WHERE id=?`, String(row[link[1]]));
  if (!parent) throw new Error(`同步资料的所属图谱不存在：${kind}`);
  return parent.project_id;
}

export async function captureLocalChanges(db: SQLiteDatabase, sha256: Sha256, assets: SyncAssets): Promise<SyncState> {
  let result: SyncState | null = null;
  await db.withExclusiveTransactionAsync(async (tx) => {
    const saved = await loadSyncState(tx);
    const state = saved ? await parseSyncState(JSON.stringify(saved), sha256) : null;
    if (!state) throw new Error('同步尚未配置');
    const dirty = await tx.getAllAsync<Dirty>('SELECT * FROM sync_changes ORDER BY revision,kind,entity_id');
    const changes: LocalChange[] = [];
    for (const change of dirty) {
      const row = await tx.getFirstAsync<Row>(`SELECT * FROM ${change.kind} WHERE ${syncIdSql(change.kind)}=?`, change.entity_id);
      const previous = await tx.getFirstAsync<{ board_id: string | null; body: string | null }>('SELECT board_id,body FROM sync_projection WHERE kind=? AND entity_id=?', change.kind, change.entity_id);
      const data: Row | null = row ? { ...(previous?.body ? JSON.parse(previous.body) as Row : {}), ...row } : null;
      const blobs: BlobRef[] = [];
      if (data && change.kind === 'source_items') {
        if (typeof data.asset_uri === 'string' && data.asset_uri) {
          const blob = await assets.exportFile(data.asset_uri, String(data.media_type));
          data.asset_blob = blob;
          blobs.push(blob);
        } else delete data.asset_blob;
        delete data.asset_uri;
      }
      if (data && change.kind === 'node_answers') data.job_id = null;
      // Pending messages are historical content on another device, never executable jobs.
      if (data && change.kind === 'conversation_messages' && data.status === 'pending') data.status = 'interrupted';
      const entity: SyncEntity = { id: change.entity_id, kind: change.kind, boardId: row ? await boardFor(tx, change.kind, row) : previous?.board_id ?? null, data };
      if (!previous || canonicalJson(data) !== canonicalJson(previous.body ? JSON.parse(previous.body) : null) || previous.board_id !== entity.boardId) {
        const heads = state.heads[entityKey(entity)] ?? [];
        const parents = heads.length > 1 ? heads.filter((revision) => {
          const version = state.commits[revision].commit.changes.find((item) => entityKey(item.entity) === entityKey(entity));
          return version && previous && version.entity.boardId === previous.board_id && canonicalJson(version.entity.data) === canonicalJson(previous.body ? JSON.parse(previous.body) : null);
        }).slice(0, 1) : heads;
        // Ordinary edits continue the displayed branch; only the resolution UI merges all heads.
        changes.push({ entity, blobs, parents });
      }
      await saveProjection(tx, entity);
    }
    result = changes.length ? await queueLocalChanges(state, changes, sha256) : state;
    await saveState(tx, result);
    await tx.runAsync('DELETE FROM sync_changes');
  });
  return result!;
}

async function saveProjection(tx: SQLiteDatabase, entity: SyncEntity) {
  await tx.runAsync('INSERT INTO sync_projection(kind,entity_id,board_id,body) VALUES(?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET board_id=excluded.board_id,body=excluded.body',
    entity.kind, entity.id, entity.boardId, entity.data === null ? null : JSON.stringify(entity.data));
}

const order = new Map<string, number>([
  'topics', 'projects', 'documents', 'nodes', 'edges', 'node_answers', 'prompt_templates', 'ai_understanding_documents',
  'project_ai_scope_settings', 'favorites', 'favorite_bindings', 'source_items', 'source_segments', 'source_citations',
  'mastery_attempts', 'graph_mutation_batches', 'conversations', 'conversation_messages', 'node_documents', 'conversation_documents', 'reading_positions',
].map((kind, index) => [kind, index]));

async function projectEntities(tx: SQLiteDatabase, entities: SyncEntity[], assets: SyncAssets) {
  await tx.execAsync('PRAGMA defer_foreign_keys=ON; UPDATE sync_control SET suppress=1 WHERE id=1;');
  const sorted = [...entities].sort((a, b) => {
    if (!a.data && b.data) return 1;
    if (a.data && !b.data) return -1;
    return ((order.get(a.kind) ?? 100) - (order.get(b.kind) ?? 100)) * (a.data ? 1 : -1);
  });
  for (const entity of sorted) {
    if (!SYNC_TABLES.includes(entity.kind as SyncTable)) {
      await saveProjection(tx, entity); // Forward-compatible opaque content is never discarded.
      continue;
    }
    const kind = entity.kind as SyncTable;
    if (entity.data === null) {
      await tx.runAsync(`DELETE FROM ${kind} WHERE ${syncIdSql(kind)}=?`, entity.id);
    } else {
      const row = { ...entity.data };
      if (kind === 'source_items') {
        if (row.asset_uri) throw new Error('同步数据包含设备路径，已拒绝写入');
        row.asset_uri = row.asset_blob ? await assets.localUri(row.asset_blob as BlobRef) : null;
      }
      if (kind === 'node_answers') row.job_id = null;
      if (kind === 'conversation_messages' && row.status === 'pending') row.status = 'interrupted';
      const columns = (await tx.getAllAsync<{ name: string }>(`PRAGMA table_info(${kind})`)).map(({ name }) => name);
      const keys = columns.filter((key) => Object.hasOwn(row, key));
      if (!keys.length) throw new Error(`同步内容缺少 ${kind} 字段`);
      const primaryKeys = SYNC_PRIMARY_KEYS[kind] ?? ['id'];
      const expectedId = primaryKeys.length > 1 ? JSON.stringify(primaryKeys.map((key) => row[key])) : row.id;
      if (expectedId !== entity.id) throw new Error('同步对象标识与资料不一致');
      const values = keys.map((key) => {
        const value = row[key];
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
        throw new Error(`同步字段格式不正确：${kind}.${key}`);
      });
      const existing = await tx.getFirstAsync<Row>(`SELECT * FROM ${kind} WHERE ${syncIdSql(kind)}=?`, entity.id);
      if (existing) {
        const updates = keys.filter((key) => !primaryKeys.includes(key) && existing[key] !== row[key]);
        if (updates.length) await tx.runAsync(`UPDATE ${kind} SET ${updates.map((key) => `${key}=?`).join(',')} WHERE ${syncIdSql(kind)}=?`, ...updates.map((key) => values[keys.indexOf(key)]), entity.id);
      } else await tx.runAsync(`INSERT INTO ${kind}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...values);
      if (await boardFor(tx, kind, row) !== entity.boardId) throw new Error('同步资料不能跨图谱引用');
    }
    await saveProjection(tx, entity);
  }
  await validateOwnership(tx);
  // SQLite cascades must never erase a retained/conflicting child implicitly.
  // Every removal has to be represented by its own durable tombstone.
  for (const table of SYNC_TABLES) {
    const missing = await tx.getFirstAsync(`SELECT p.entity_id FROM sync_projection p WHERE p.kind=? AND p.body IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${table} t WHERE ${syncIdSql(table, 't')}=p.entity_id) LIMIT 1`, table);
    if (missing) throw new Error('同步删除涉及仍保留的子资料或冲突版本；已回滚并保留原数据，请先在原设备解决关联资料');
  }
  const foreignKey = await tx.getFirstAsync('PRAGMA foreign_key_check');
  if (foreignKey) throw new Error('同步内容引用了不存在的资料；已保留原数据等待完整内容');
  await tx.execAsync('UPDATE sync_control SET suppress=0 WHERE id=1;');
}

/** Foreign keys alone cannot reject a valid document belonging to another graph. */
async function validateOwnership(tx: SQLiteDatabase) {
  const checks = [
    'SELECT 1 FROM nodes n JOIN documents d ON d.id=n.document_id WHERE n.project_id!=d.project_id',
    'SELECT 1 FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id JOIN documents d ON d.id=e.document_id WHERE e.project_id!=s.project_id OR e.project_id!=t.project_id OR e.project_id!=d.project_id',
    'SELECT 1 FROM node_documents nd JOIN nodes n ON n.id=nd.node_id JOIN documents d ON d.id=nd.document_id WHERE n.project_id!=d.project_id',
    'SELECT 1 FROM node_answers a JOIN nodes n ON n.id=a.node_id WHERE a.project_id!=n.project_id',
    'SELECT 1 FROM mastery_attempts a JOIN nodes n ON n.id=a.node_id WHERE a.project_id!=n.project_id',
    'SELECT 1 FROM favorites f JOIN nodes n ON n.id=f.node_id LEFT JOIN node_answers a ON f.target_type=\'answer\' AND a.id=f.target_id WHERE f.project_id!=n.project_id OR (f.target_type=\'node\' AND f.target_id!=f.node_id) OR (f.target_type=\'answer\' AND (a.id IS NULL OR a.project_id!=f.project_id OR a.node_id!=f.node_id))',
    'SELECT 1 FROM source_items s JOIN documents d ON d.id=s.derived_document_id WHERE s.project_id!=d.project_id',
    'SELECT 1 FROM source_citations c JOIN source_items s ON s.id=c.source_item_id WHERE c.project_id!=s.project_id',
    `SELECT 1 FROM source_citations c LEFT JOIN (
       SELECT 'node' AS kind,id,project_id FROM nodes UNION ALL SELECT 'edge',id,project_id FROM edges
       UNION ALL SELECT 'answer',id,project_id FROM node_answers UNION ALL SELECT 'document',id,project_id FROM documents
     ) target ON target.kind=c.target_type AND target.id=c.target_id WHERE target.id IS NULL OR c.project_id!=target.project_id`,
    'SELECT 1 FROM graph_mutation_batches b JOIN node_answers a ON a.id=b.answer_id WHERE b.project_id!=a.project_id',
    'SELECT 1 FROM conversations c JOIN nodes n ON n.id=c.node_id WHERE c.project_id!=n.project_id',
    'SELECT 1 FROM conversation_documents c JOIN documents d ON d.id=c.document_id LEFT JOIN nodes n ON n.id=c.node_id LEFT JOIN conversations conv ON conv.id=c.conversation_id LEFT JOIN node_answers a ON a.id=c.source_answer_id WHERE (n.id IS NOT NULL AND d.project_id!=n.project_id) OR (conv.id IS NOT NULL AND conv.project_id!=d.project_id) OR (a.id IS NOT NULL AND a.project_id!=d.project_id)',
  ];
  for (const check of checks) if (await tx.getFirstAsync(`${check} LIMIT 1`)) throw new Error('同步内容包含跨图谱引用，已回滚此次接收');
}

export async function applySyncApplication(db: SQLiteDatabase, application: SyncApplication, assets: SyncAssets) {
  // Files are immutable content-addressed copies. An interrupted SQL transaction can only leave harmless orphan blobs.
  for (const blob of application.blobs) await assets.install(blob.ref, blob.bytes);
  try {
    await db.withExclusiveTransactionAsync(async (tx) => {
      if (application.entities.length) {
        const dirty = await tx.getFirstAsync('SELECT 1 FROM sync_changes LIMIT 1');
        if (dirty) throw new Error('同步期间有新的本地修改，已保留并等待下一轮合并');
        await projectEntities(tx, application.entities, assets);
      }
      await saveState(tx, application.state);
      if (application.commit) await tx.runAsync('UPDATE sync_blocked_inbound SET resolved_at=? WHERE id=?', new Date().toISOString(), application.commit.id);
    });
  } catch (error) {
    if (application.commit && error instanceof Error && /同步删除|跨图谱|引用了不存在/.test(error.message)) {
      const localEntities: SyncEntity[] = [];
      const boards = new Set(application.commit.changes.map((change) => change.entity.boardId).filter((id): id is string => id !== null));
      for (const row of await db.getAllAsync<{ kind: string; entity_id: string; board_id: string | null; body: string | null }>('SELECT * FROM sync_projection WHERE body IS NOT NULL')) {
        if (boards.has(row.board_id ?? '') || application.commit.changes.some((change) => change.entity.kind === row.kind && change.entity.id === row.entity_id)) localEntities.push({ kind: row.kind, id: row.entity_id, boardId: row.board_id, data: JSON.parse(row.body!) });
      }
      await db.runAsync('INSERT INTO sync_blocked_inbound(id,body,reason,created_at,resolved_at) VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET body=excluded.body,reason=excluded.reason,resolved_at=NULL',
        application.commit.id, JSON.stringify({ state: application.state, commit: application.commit, conflicts: application.conflicts, localEntities }), error.message, new Date().toISOString());
    }
    throw error;
  }
}

/** Explicitly supersede this rejected commit with the corresponding current local versions. */
export async function keepLocalBlockedSync(db: SQLiteDatabase, id: string, sha256: Sha256) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await requireIdle(tx);
    if (await tx.getFirstAsync('SELECT 1 FROM sync_changes LIMIT 1')) throw new Error('请先立即同步一次，记录最新本地修改，再保留本机版本');
    const row = await tx.getFirstAsync<{ body: string }>('SELECT body FROM sync_blocked_inbound WHERE id=? AND resolved_at IS NULL', id);
    if (!row) throw new Error('此同步记录已处理，请刷新');
    const blocked = JSON.parse(row.body) as { state: SyncState; commit: SyncCommit };
    const candidate = await parseSyncState(JSON.stringify(blocked.state), sha256);
    const current = await loadSyncState(tx);
    if (!current || current.deviceId !== candidate.deviceId || current.libraryId !== candidate.libraryId || current.nextSequence !== candidate.nextSequence
      || Object.entries(current.commits).some(([key, value]) => candidate.commits[key]?.sha256 !== value.sha256)
      || Object.keys(candidate.commits).length !== Object.keys(current.commits).length + 1) throw new Error('同步状态已有更新，请立即同步后再选择保留本机版本');
    const changes: LocalChange[] = [];
    for (const change of blocked.commit.changes) {
      const entity = change.entity;
      const projection = await tx.getFirstAsync<{ body: string | null; board_id: string | null }>('SELECT body,board_id FROM sync_projection WHERE kind=? AND entity_id=?', entity.kind, entity.id);
      const data = projection?.body ? JSON.parse(projection.body) as Record<string, unknown> : null;
      const local: SyncEntity = { ...entity, boardId: projection?.board_id ?? entity.boardId, data };
      changes.push({ entity: local, blobs: data?.asset_blob ? [data.asset_blob as BlobRef] : [] });
    }
    const next = await queueLocalChanges({ ...candidate, outbox: [...current.outbox] }, changes, sha256);
    // Projection is intentionally unchanged; acceptance and the explicit resolution are one SQL commit.
    await saveState(tx, next);
    await tx.runAsync('UPDATE sync_blocked_inbound SET resolved_at=? WHERE id=?', new Date().toISOString(), id);
    await tx.runAsync("UPDATE sync_settings SET status='pending',last_error=NULL WHERE id=1");
  });
}

export async function resolveSyncConflict(db: SQLiteDatabase, conflictKey: string, revision: string, editedMarkdown: string | undefined, sha256: Sha256, assets: SyncAssets) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await requireIdle(tx);
    if (await tx.getFirstAsync('SELECT 1 FROM sync_changes LIMIT 1')) throw new Error('请先同步本地修改，然后处理版本冲突');
    const state = await loadSyncState(tx);
    if (!state) throw new Error('同步尚未配置');
    const conflict = getConflicts(state).find((item) => item.key === conflictKey);
    const selected = conflict?.versions.find((item) => item.revision === revision);
    if (!selected) throw new Error('版本已变化，请刷新后重试');
    const entity = { ...selected.entity, data: selected.entity.data ? { ...selected.entity.data } : null };
    if (editedMarkdown !== undefined) {
      if (!entity.data || typeof entity.data.body !== 'string') throw new Error('此对象不支持 Markdown 合并');
      entity.data.body = editedMarkdown;
      if ('updated_at' in entity.data) entity.data.updated_at = new Date().toISOString();
    }
    await projectEntities(tx, [entity], assets);
    await saveState(tx, await queueLocalChanges(state, [{ entity, blobs: selected.blobs }], sha256));
  });
}
