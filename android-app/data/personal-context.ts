import type { SQLiteDatabase } from 'expo-sqlite';

import type { FutureContextEvidence } from '@/ai/context-plan';
import type {
  AiUnderstandingDocument,
  FavoriteItem,
  FavoriteTargetType,
  ProjectUnderstandingScope,
  Topic,
  UnderstandingCategory,
  UnderstandingScopeType,
} from '@/types/domain';

type TopicRow = {
  id: string;
  parent_id: string | null;
  title: string;
  child_topic_count: number;
  project_count: number;
  created_at: string;
  updated_at: string;
};

type UnderstandingRow = {
  id: string;
  scope_type: UnderstandingScopeType;
  scope_id: string;
  category: UnderstandingCategory;
  title: string;
  body: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type FavoriteRow = {
  id: string;
  target_type: FavoriteTargetType;
  target_id: string;
  project_id: string;
  project_title: string;
  node_id: string;
  node_title: string;
  title: string;
  body: string;
  created_at: string;
};

type BindingRow = {
  favorite_id: string;
  scope_type: UnderstandingScopeType;
  scope_id: string;
};

export class FavoriteDependencyError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly nodeId: string | null,
    public readonly favoriteCount: number,
  ) {
    super(`有 ${favoriteCount} 条收藏仍引用这里，请先在收藏中心取消收藏`);
    this.name = 'FavoriteDependencyError';
  }
}

export async function listTopics(db: SQLiteDatabase, parentId: string | null): Promise<Topic[]> {
  const rows = parentId
    ? await db.getAllAsync<TopicRow>(
      `${topicQuery} WHERE t.parent_id = ? ORDER BY t.updated_at DESC, t.title`,
      parentId,
    )
    : await db.getAllAsync<TopicRow>(
      `${topicQuery} WHERE t.parent_id IS NULL ORDER BY t.updated_at DESC, t.title`,
    );
  return rows.map(mapTopic);
}

export async function listAllTopics(db: SQLiteDatabase): Promise<Topic[]> {
  const rows = await db.getAllAsync<TopicRow>(`${topicQuery} ORDER BY t.created_at, t.title`);
  return rows.map(mapTopic);
}

export async function getTopic(db: SQLiteDatabase, topicId: string): Promise<Topic | null> {
  const row = await db.getFirstAsync<TopicRow>(`${topicQuery} WHERE t.id = ?`, topicId);
  return row ? mapTopic(row) : null;
}

export async function listTopicAncestors(db: SQLiteDatabase, topicId: string): Promise<Topic[]> {
  const result: Topic[] = [];
  const seen = new Set<string>();
  let currentId: string | null = topicId;
  while (currentId) {
    if (seen.has(currentId)) throw new Error('专题层级存在循环，无法继续');
    seen.add(currentId);
    const topic = await getTopic(db, currentId);
    if (!topic) break;
    result.unshift(topic);
    currentId = topic.parentId;
  }
  return result;
}

export async function createTopic(db: SQLiteDatabase, title: string, parentId: string | null) {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error('专题名称不能为空');
  if (cleanTitle.length > 80) throw new Error('专题名称不能超过 80 个字符');
  if (parentId && !(await getTopic(db, parentId))) throw new Error('上级专题不存在');
  const now = new Date().toISOString();
  const id = createId('topic');
  await db.runAsync(
    'INSERT INTO topics (id, parent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    parentId,
    cleanTitle,
    now,
    now,
  );
  return id;
}

export async function deleteEmptyTopic(db: SQLiteDatabase, topicId: string) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const impact = await transaction.getFirstAsync<{ child_count: number; project_count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM topics WHERE parent_id = ?) AS child_count,
         (SELECT COUNT(*) FROM projects WHERE topic_id = ?) AS project_count`,
      topicId,
      topicId,
    );
    if (!impact) throw new Error('专题不存在');
    if (impact.child_count > 0 || impact.project_count > 0) {
      throw new Error('只能删除空专题；请先移动其中的子专题和图谱');
    }
    const result = await transaction.runAsync('DELETE FROM topics WHERE id = ?', topicId);
    if (result.changes !== 1) throw new Error('专题不存在或已经删除');
  });
}

export async function moveProjectToTopic(
  db: SQLiteDatabase,
  projectId: string,
  topicId: string | null,
) {
  if (topicId && !(await getTopic(db, topicId))) throw new Error('目标专题不存在');
  const result = await db.runAsync(
    'UPDATE projects SET topic_id = ?, updated_at = ? WHERE id = ?',
    topicId,
    new Date().toISOString(),
    projectId,
  );
  if (result.changes !== 1) throw new Error('学习图谱不存在');
}

export async function listUnderstandingDocuments(
  db: SQLiteDatabase,
  scopeType: UnderstandingScopeType,
  scopeId: string,
): Promise<AiUnderstandingDocument[]> {
  const rows = await db.getAllAsync<UnderstandingRow>(
    `SELECT * FROM ai_understanding_documents
     WHERE scope_type = ? AND scope_id = ?
     ORDER BY category, updated_at DESC`,
    scopeType,
    scopeId,
  );
  return rows.map(mapUnderstanding);
}

export async function saveUnderstandingDocument(
  db: SQLiteDatabase,
  input: {
    id?: string;
    scopeType: UnderstandingScopeType;
    scopeId: string;
    category: UnderstandingCategory;
    title: string;
    body: string;
    enabled?: boolean;
  },
) {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new Error('标题和内容都不能为空');
  if (title.length > 120) throw new Error('标题不能超过 120 个字符');
  if (body.length > 20_000) throw new Error('单条内容不能超过 20,000 个字符');
  const now = new Date().toISOString();
  if (input.id) {
    const result = await db.runAsync(
      `UPDATE ai_understanding_documents
       SET category = ?, title = ?, body = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND scope_type = ? AND scope_id = ?`,
      input.category,
      title,
      body,
      input.enabled === false ? 0 : 1,
      now,
      input.id,
      input.scopeType,
      input.scopeId,
    );
    if (result.changes !== 1) throw new Error('这条内容不存在或已经删除');
    return input.id;
  }
  const id = createId('understanding');
  await db.runAsync(
    `INSERT INTO ai_understanding_documents
      (id, scope_type, scope_id, category, title, body, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.scopeType,
    input.scopeId,
    input.category,
    title,
    body,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return id;
}

export async function deleteUnderstandingDocument(db: SQLiteDatabase, id: string) {
  const result = await db.runAsync('DELETE FROM ai_understanding_documents WHERE id = ?', id);
  if (result.changes !== 1) throw new Error('这条内容不存在或已经删除');
}

export async function listProjectUnderstandingScopes(
  db: SQLiteDatabase,
  projectId: string,
): Promise<ProjectUnderstandingScope[]> {
  const project = await db.getFirstAsync<{ title: string; topic_id: string | null }>(
    'SELECT title, topic_id FROM projects WHERE id = ?',
    projectId,
  );
  if (!project) throw new Error('学习图谱不存在');
  const ancestors = project.topic_id ? await listTopicAncestors(db, project.topic_id) : [];
  const candidates: Array<Omit<ProjectUnderstandingScope, 'enabled' | 'documentCount'>> = [
    { scopeType: 'global', scopeId: 'global', label: '全局 · 所有学习图谱', depth: 0 },
    ...ancestors.map((topic, index) => ({
      scopeType: 'topic' as const,
      scopeId: topic.id,
      label: `${'  '.repeat(index)}专题 · ${topic.title}`,
      depth: index + 1,
    })),
    {
      scopeType: 'project',
      scopeId: projectId,
      label: `当前图谱 · ${project.title}`,
      depth: ancestors.length + 1,
    },
  ];
  const settings = await db.getAllAsync<{
    scope_type: UnderstandingScopeType;
    scope_id: string;
    enabled: number;
  }>('SELECT scope_type, scope_id, enabled FROM project_ai_scope_settings WHERE project_id = ?', projectId);
  const settingMap = new Map(settings.map((item) => [`${item.scope_type}:${item.scope_id}`, item.enabled === 1]));
  const counts = await db.getAllAsync<{
    scope_type: UnderstandingScopeType;
    scope_id: string;
    count: number;
  }>(`SELECT scope_type, scope_id, COUNT(*) AS count
      FROM ai_understanding_documents
      WHERE enabled = 1
      GROUP BY scope_type, scope_id`);
  const countMap = new Map(counts.map((item) => [`${item.scope_type}:${item.scope_id}`, item.count]));
  return candidates.map((item) => {
    const key = `${item.scopeType}:${item.scopeId}`;
    return {
      ...item,
      enabled: settingMap.get(key) ?? true,
      documentCount: countMap.get(key) ?? 0,
    };
  });
}

export async function setProjectUnderstandingScopeEnabled(
  db: SQLiteDatabase,
  projectId: string,
  scopeType: UnderstandingScopeType,
  scopeId: string,
  enabled: boolean,
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO project_ai_scope_settings (project_id, scope_type, scope_id, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, scope_type, scope_id)
     DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    projectId,
    scopeType,
    scopeId,
    enabled ? 1 : 0,
    now,
  );
}

export async function listFavorites(
  db: SQLiteDatabase,
  filter: { projectId?: string; nodeId?: string } = {},
): Promise<FavoriteItem[]> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.projectId) {
    clauses.push('f.project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.nodeId) {
    clauses.push('f.node_id = ?');
    params.push(filter.nodeId);
  }
  const rows = await db.getAllAsync<FavoriteRow>(
    `${favoriteQuery}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY f.created_at DESC`,
    ...params,
  );
  const bindings = rows.length
    ? await db.getAllAsync<BindingRow>(
      `SELECT favorite_id, scope_type, scope_id
       FROM favorite_bindings
       WHERE favorite_id IN (${rows.map(() => '?').join(',')})`,
      ...rows.map((item) => item.id),
    )
    : [];
  const bindingMap = new Map<string, FavoriteItem['bindings']>();
  for (const binding of bindings) {
    const current = bindingMap.get(binding.favorite_id) ?? [];
    current.push({ scopeType: binding.scope_type, scopeId: binding.scope_id });
    bindingMap.set(binding.favorite_id, current);
  }
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    nodeId: row.node_id,
    nodeTitle: row.node_title,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    bindings: bindingMap.get(row.id) ?? [],
  }));
}

export async function isNodeFavorite(db: SQLiteDatabase, nodeId: string) {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM favorites WHERE target_type = 'node' AND target_id = ?`,
    nodeId,
  );
  return (row?.count ?? 0) > 0;
}

export async function setNodeFavorite(db: SQLiteDatabase, nodeId: string, saved: boolean) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const node = await transaction.getFirstAsync<{ project_id: string }>(
      'SELECT project_id FROM nodes WHERE id = ?',
      nodeId,
    );
    if (!node) throw new Error('节点不存在');
    if (saved) {
      await transaction.runAsync(
        `INSERT OR IGNORE INTO favorites
          (id, target_type, target_id, project_id, node_id, created_at)
         VALUES (?, 'node', ?, ?, ?, ?)`,
        `favorite-node-${nodeId}`,
        nodeId,
        node.project_id,
        nodeId,
        new Date().toISOString(),
      );
    } else {
      await transaction.runAsync(
        `DELETE FROM favorites WHERE target_type = 'node' AND target_id = ?`,
        nodeId,
      );
    }
  });
}

export async function setAnswerFavorite(db: SQLiteDatabase, answerId: string, saved: boolean) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const answer = await transaction.getFirstAsync<{
      project_id: string;
      node_id: string;
    }>('SELECT project_id, node_id FROM node_answers WHERE id = ?', answerId);
    if (!answer) throw new Error('回答不存在');
    if (saved) {
      const now = new Date().toISOString();
      await transaction.runAsync(
        `INSERT OR IGNORE INTO favorites
          (id, target_type, target_id, project_id, node_id, created_at)
         VALUES (?, 'answer', ?, ?, ?, ?)`,
        `favorite-answer-${answerId}`,
        answerId,
        answer.project_id,
        answer.node_id,
        now,
      );
      await transaction.runAsync('UPDATE node_answers SET is_saved = 1, updated_at = ? WHERE id = ?', now, answerId);
    } else {
      await transaction.runAsync(
        `DELETE FROM favorites WHERE target_type = 'answer' AND target_id = ?`,
        answerId,
      );
      await transaction.runAsync(
        'UPDATE node_answers SET is_saved = 0, updated_at = ? WHERE id = ?',
        new Date().toISOString(),
        answerId,
      );
    }
  });
}

export async function removeFavorite(db: SQLiteDatabase, favoriteId: string) {
  const result = await db.runAsync('DELETE FROM favorites WHERE id = ?', favoriteId);
  if (result.changes !== 1) throw new Error('收藏不存在或已经删除');
}

export async function setFavoriteBinding(
  db: SQLiteDatabase,
  favoriteId: string,
  scopeType: UnderstandingScopeType,
  scopeId: string,
  enabled: boolean,
) {
  if (enabled) {
    await db.runAsync(
      `INSERT OR IGNORE INTO favorite_bindings (scope_type, scope_id, favorite_id, created_at)
       VALUES (?, ?, ?, ?)`,
      scopeType,
      scopeId,
      favoriteId,
      new Date().toISOString(),
    );
  } else {
    await db.runAsync(
      'DELETE FROM favorite_bindings WHERE scope_type = ? AND scope_id = ? AND favorite_id = ?',
      scopeType,
      scopeId,
      favoriteId,
    );
  }
}

export async function assertNoFavoriteDependencies(
  db: SQLiteDatabase,
  input: { projectId: string; nodeId?: string },
) {
  const row = input.nodeId
    ? await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM favorites WHERE project_id = ? AND node_id = ?',
      input.projectId,
      input.nodeId,
    )
    : await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM favorites WHERE project_id = ?',
      input.projectId,
    );
  const count = row?.count ?? 0;
  if (count > 0) throw new FavoriteDependencyError(input.projectId, input.nodeId ?? null, count);
}

export async function loadPersonalContextEvidence(
  db: SQLiteDatabase,
  projectId: string,
  question: string,
): Promise<{
  evidence: FutureContextEvidence[];
  scopes: ProjectUnderstandingScope[];
}> {
  const scopes = await listProjectUnderstandingScopes(db, projectId);
  const active = scopes.filter((scope) => scope.enabled);
  const evidence: FutureContextEvidence[] = [];
  for (const scope of active) {
    const documents = await listUnderstandingDocuments(db, scope.scopeType, scope.scopeId);
    for (const document of documents.filter((item) => item.enabled)) {
      evidence.push({
        id: document.id,
        kind: 'soul',
        category: document.category,
        title: document.title,
        text: document.body,
        provenance: scope.label,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        scopeLabel: scope.label,
      });
    }
  }

  const activeKeys = new Set(active.map((scope) => `${scope.scopeType}:${scope.scopeId}`));
  const activeByKey = new Map(active.map((scope) => [`${scope.scopeType}:${scope.scopeId}`, scope]));
  const allBindings = await db.getAllAsync<BindingRow>(
    `SELECT favorite_id, scope_type, scope_id FROM favorite_bindings`,
  );
  const selectedFavoriteIds = [...new Set(allBindings
    .filter((binding) => activeKeys.has(`${binding.scope_type}:${binding.scope_id}`))
    .map((binding) => binding.favorite_id))];
  if (selectedFavoriteIds.length) {
    const favorites = await listFavoritesByIds(db, selectedFavoriteIds);
    for (const favorite of favorites) {
      const binding = allBindings.find((item) => (
        item.favorite_id === favorite.id
        && activeKeys.has(`${item.scope_type}:${item.scope_id}`)
      ));
      const boundScope = binding
        ? activeByKey.get(`${binding.scope_type}:${binding.scope_id}`)
        : undefined;
      evidence.push({
        id: favorite.id,
        kind: 'favorite',
        category: 'favorite',
        title: favorite.title,
        text: boundedText(favorite.body, 6_000),
        provenance: `用户收藏 · ${favorite.projectTitle} · ${favorite.nodeTitle}`,
        scopeType: boundScope?.scopeType ?? 'project',
        scopeId: boundScope?.scopeId ?? favorite.projectId,
        scopeLabel: boundScope?.label ?? favorite.projectTitle,
      });
    }
  }

  await rebuildContextSearchIndex(db);
  const searchHits = await searchContextIndex(db, question);
  return {
    scopes,
    evidence: evidence.map((item) => ({
      ...item,
      searchBoost: searchHits.has(`${item.kind}:${item.id}`) ? 24 : 0,
    })),
  };
}

export async function rebuildContextSearchIndex(db: SQLiteDatabase) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM context_search_fts');
    const documents = await transaction.getAllAsync<{
      id: string;
      project_id: string;
      title: string;
      body: string;
    }>(
      `SELECT n.id, n.project_id, n.title, d.body
       FROM nodes n JOIN documents d ON d.id = n.document_id`,
    );
    const answers = await transaction.getAllAsync<{
      id: string;
      project_id: string;
      question: string;
      body: string;
    }>('SELECT id, project_id, question, body FROM node_answers');
    const understanding = await transaction.getAllAsync<UnderstandingRow>(
      'SELECT * FROM ai_understanding_documents WHERE enabled = 1',
    );
    const favorites = await transaction.getAllAsync<FavoriteRow>(favoriteQuery);
    for (const document of documents) {
      await transaction.runAsync(
        `INSERT INTO context_search_fts (kind, source_id, project_id, title, body)
         VALUES ('node', ?, ?, ?, ?)`,
        document.id,
        document.project_id,
        document.title,
        document.body,
      );
    }
    for (const answer of answers) {
      await transaction.runAsync(
        `INSERT INTO context_search_fts (kind, source_id, project_id, title, body)
         VALUES ('answer', ?, ?, ?, ?)`,
        answer.id,
        answer.project_id,
        answer.question,
        answer.body,
      );
    }
    for (const item of understanding) {
      await transaction.runAsync(
        `INSERT INTO context_search_fts (kind, source_id, project_id, title, body)
         VALUES ('soul', ?, '', ?, ?)`,
        item.id,
        item.title,
        item.body,
      );
    }
    for (const favorite of favorites) {
      await transaction.runAsync(
        `INSERT INTO context_search_fts (kind, source_id, project_id, title, body)
         VALUES ('favorite', ?, ?, ?, ?)`,
        favorite.id,
        favorite.project_id,
        favorite.title,
        favorite.body,
      );
    }
  });
}

async function searchContextIndex(db: SQLiteDatabase, question: string) {
  const terms = question
    .toLocaleLowerCase()
    .match(/[a-z0-9_+-]{2,}|[\p{Script=Han}]{2,}/gu)
    ?.slice(0, 8)
    .map((term) => `"${term.replace(/"/gu, '""')}"`) ?? [];
  if (!terms.length) return new Set<string>();
  try {
    const rows = await db.getAllAsync<{ kind: string; source_id: string }>(
      `SELECT kind, source_id FROM context_search_fts
       WHERE context_search_fts MATCH ?
       ORDER BY bm25(context_search_fts)
       LIMIT 32`,
      terms.join(' OR '),
    );
    return new Set(rows.map((item) => `${item.kind}:${item.source_id}`));
  } catch {
    return new Set<string>();
  }
}

async function listFavoritesByIds(db: SQLiteDatabase, ids: string[]) {
  const rows = await db.getAllAsync<FavoriteRow>(
    `${favoriteQuery} WHERE f.id IN (${ids.map(() => '?').join(',')}) ORDER BY f.created_at DESC`,
    ...ids,
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    nodeId: row.node_id,
    nodeTitle: row.node_title,
    title: row.title,
    body: row.body,
  }));
}

const topicQuery = `
  SELECT t.*,
    (SELECT COUNT(*) FROM topics child WHERE child.parent_id = t.id) AS child_topic_count,
    (SELECT COUNT(*) FROM projects p WHERE p.topic_id = t.id) AS project_count
  FROM topics t
`;

const favoriteQuery = `
  SELECT
    f.id,
    f.target_type,
    f.target_id,
    f.project_id,
    p.title AS project_title,
    f.node_id,
    n.title AS node_title,
    CASE WHEN f.target_type = 'answer' THEN a.question ELSE n.title END AS title,
    CASE WHEN f.target_type = 'answer' THEN a.body ELSE d.body END AS body,
    f.created_at
  FROM favorites f
  JOIN projects p ON p.id = f.project_id
  JOIN nodes n ON n.id = f.node_id
  JOIN documents d ON d.id = n.document_id
  LEFT JOIN node_answers a ON f.target_type = 'answer' AND a.id = f.target_id
`;

function mapTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    childTopicCount: row.child_topic_count,
    projectCount: row.project_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUnderstanding(row: UnderstandingRow): AiUnderstandingDocument {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    category: row.category,
    title: row.title,
    body: row.body,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boundedText(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max).trim()}\n\n[收藏内容已按上限截断]`;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
