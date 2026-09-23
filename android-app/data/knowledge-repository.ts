import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  DetailLevel,
  EdgeReviewStatus,
  ExplanationStyle,
  GraphMutationBatch,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeStatus,
  LearningProject,
  LayoutDirection,
  MarkdownDocument,
  ProjectContentPolicy,
  ProjectMode,
  RelationType,
} from '@/types/domain';
import type { ExpansionContext, GraphPatch } from '@/ai/graph-patch';
import { resolveContentContract } from '@/ai/content-policy';
import { markExpansionSucceededInTransaction } from '@/data/expansion-jobs';
import { insertNodeAnswerInTransaction, listNodeAnswers } from '@/data/node-answers';
import { assertNoFavoriteDependencies } from '@/data/personal-context';
import type { ExpansionAdapter } from '@/data/expansion-jobs';
import { computeHierarchyLayout } from '@/components/hierarchy-layout';

type ProjectRow = {
  id: string;
  topic_id: string | null;
  title: string;
  source_text: string;
  mode: ProjectMode;
  explanation_style: ExplanationStyle;
  detail_level: DetailLevel;
  allow_outside_knowledge: number;
  created_at: string;
  updated_at: string;
  node_count: number;
  mastered_count: number;
  layout_direction: LayoutDirection;
  graph_kind?: LearningProject['graphKind'];
};

type DocumentRow = {
  id: string;
  project_id: string;
  path: string;
  title: string;
  body: string;
  origin: MarkdownDocument['origin'];
  created_at: string;
  updated_at: string;
};

type NodeRow = {
  id: string;
  project_id: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  importance: number;
  status: KnowledgeNode['status'];
  sort_order: number | null;
  document_id: string;
};

type EdgeRow = {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  relation: KnowledgeEdge['relation'];
  effective_relation: KnowledgeEdge['relation'] | null;
  importance: number;
  document_id: string;
  review_status: EdgeReviewStatus;
  reviewed_at: string | null;
  relation_kind?: string | null;
  directed?: number;
  label?: string;
};

const projectQuery = `
  SELECT p.*,
    (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id) AS node_count,
    (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.status = 'mastered') AS mastered_count
  FROM projects p
`;

export async function listProjects(
  db: SQLiteDatabase,
  topicId?: string | null,
): Promise<LearningProject[]> {
  const rows = topicId === undefined
    ? await db.getAllAsync<ProjectRow>(`${projectQuery} ORDER BY p.updated_at DESC`)
    : topicId === null
      ? await db.getAllAsync<ProjectRow>(`${projectQuery} WHERE p.topic_id IS NULL ORDER BY p.updated_at DESC`)
      : await db.getAllAsync<ProjectRow>(`${projectQuery} WHERE p.topic_id = ? ORDER BY p.updated_at DESC`, topicId);
  return rows.map(mapProject);
}

export async function getGraph(db: SQLiteDatabase, projectId: string): Promise<KnowledgeGraph | null> {
  const [projectRow, nodeRows, edgeRows] = await Promise.all([
    db.getFirstAsync<ProjectRow>(`${projectQuery} WHERE p.id = ?`, projectId),
    db.getAllAsync<NodeRow>('SELECT * FROM nodes WHERE project_id = ? ORDER BY sort_order, id', projectId),
    db.getAllAsync<EdgeRow>('SELECT * FROM edges WHERE project_id = ? ORDER BY id', projectId),
  ]);

  if (!projectRow) return null;
  return {
    project: mapProject(projectRow),
    nodes: nodeRows.map(mapNode),
    edges: edgeRows.map(mapEdge),
  };
}

export async function getDocument(db: SQLiteDatabase, id: string): Promise<MarkdownDocument | null> {
  const row = await db.getFirstAsync<DocumentRow>('SELECT * FROM documents WHERE id = ?', id);
  return row ? mapDocument(row) : null;
}

export async function updateDocument(db: SQLiteDatabase, id: string, body: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE documents SET body = ?, origin = 'learner', updated_at = ? WHERE id = ?",
    body,
    now,
    id,
  );
}

export async function updateEdgeReviewStatus(
  db: SQLiteDatabase,
  edgeId: string,
  reviewStatus: EdgeReviewStatus,
) {
  const reviewedAt = reviewStatus === 'unverified' ? null : new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const result = await transaction.runAsync(
      'UPDATE edges SET review_status = ?, reviewed_at = ? WHERE id = ?',
      reviewStatus,
      reviewedAt,
      edgeId,
    );
    if (result.changes !== 1) throw new Error('当前关系不存在');
    await transaction.runAsync(
      'UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM edges WHERE id = ?)',
      new Date().toISOString(),
      edgeId,
    );
  });
  return { reviewStatus, reviewedAt };
}

export type NodeDeleteImpact = {
  nodeId: string;
  title: string;
  isRoot: boolean;
  edgeCount: number;
  answerCount: number;
  favoriteCount: number;
  activeJobCount: number;
};

export async function updateNodeStatus(db: SQLiteDatabase, nodeId: string, status: KnowledgeNode['status']) {
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const node = await transaction.getFirstAsync<Pick<NodeRow, 'project_id'>>('SELECT project_id FROM nodes WHERE id = ?', nodeId);
    if (!node) throw new Error('当前节点不存在');
    const result = await transaction.runAsync('UPDATE nodes SET status = ? WHERE id = ?', status, nodeId);
    if (result.changes !== 1) throw new Error('节点状态没有更新');
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, node.project_id);
  });
}

export async function getNodeDeleteImpact(db: SQLiteDatabase, nodeId: string): Promise<NodeDeleteImpact> {
  return readNodeDeleteImpact(db, nodeId);
}

export async function deleteKnowledgeNode(db: SQLiteDatabase, nodeId: string) {
  let deletedImpact: NodeDeleteImpact | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const impact = await readNodeDeleteImpact(transaction, nodeId);
    if (impact.isRoot) throw new Error('根目标不能作为单个节点删除；如需清空请使用“删除项目”');
    if (impact.activeJobCount > 0) throw new Error('这个节点仍有 AI 任务正在执行或等待恢复，当前不能删除');
    const node = await transaction.getFirstAsync<Pick<NodeRow, 'project_id' | 'document_id'>>(
      'SELECT project_id, document_id FROM nodes WHERE id = ?',
      nodeId,
    );
    if (!node) throw new Error('当前节点不存在');
    await assertNoFavoriteDependencies(transaction, { projectId: node.project_id, nodeId });
    const edgeDocuments = await transaction.getAllAsync<{ id:string; document_id: string }>(
      'SELECT id, document_id FROM edges WHERE source_id = ? OR target_id = ?',
      nodeId,
      nodeId,
    );
    const answers = await transaction.getAllAsync<{id:string}>('SELECT id FROM node_answers WHERE node_id=?',nodeId);
    await transaction.runAsync(
      `DELETE FROM ai_expansion_jobs
       WHERE project_id = ? AND selection_id = ? AND status NOT IN ('queued', 'running', 'retry_wait')`,
      node.project_id,
      nodeId,
    );
    const result = await transaction.runAsync('DELETE FROM nodes WHERE id = ?', nodeId);
    if (result.changes !== 1) throw new Error('节点删除没有完成');
    const fusion = await transaction.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='node_documents'");
    for (const documentId of new Set([node.document_id, ...edgeDocuments.map((item) => item.document_id)])) {
      if (fusion && await transaction.getFirstAsync('SELECT 1 FROM node_documents WHERE document_id=? UNION ALL SELECT 1 FROM conversation_documents WHERE document_id=? LIMIT 1',documentId,documentId)) continue;
      await transaction.runAsync(
        `DELETE FROM documents
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM nodes WHERE document_id = ?)
           AND NOT EXISTS (SELECT 1 FROM edges WHERE document_id = ?)`,
        documentId,
        documentId,
        documentId,
      );
    }
    await reflowProjectGraphInTransaction(transaction, node.project_id);
    await cleanDeletedCitations(transaction,{node:[nodeId],edge:edgeDocuments.map(e=>e.id),document:[node.document_id,...edgeDocuments.map(e=>e.document_id)],answer:answers.map(a=>a.id)});
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', new Date().toISOString(), node.project_id);
    deletedImpact = impact;
  });
  return deletedImpact!;
}

export async function reflowProjectGraph(db: SQLiteDatabase, projectId: string, direction?: LayoutDirection) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    if (direction) {
      await transaction.runAsync(
        'UPDATE projects SET layout_direction = ? WHERE id = ?',
        direction,
        projectId,
      );
    }
    await reflowProjectGraphInTransaction(transaction, projectId, direction);
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', new Date().toISOString(), projectId);
  });
}

export async function createProject(
  db: SQLiteDatabase,
  title: string,
  sourceText: string,
  topicId: string | null = null,
  contentPolicy: Partial<LearningProject['contentPolicy']> = {},
) {
  const projectId = createId('project');
  const documentId = createId('doc');
  const nodeId = createId('node');
  const now = new Date().toISOString();
  const cleanTitle = title.trim();
  const mode = contentPolicy.mode ?? 'learning';
  const explanationStyle = contentPolicy.explanationStyle ?? 'plain_language';
  const detailLevel = contentPolicy.detailLevel ?? 'detailed';
  const allowOutsideKnowledge = contentPolicy.allowOutsideKnowledge ?? mode === 'learning';

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO projects (
        id, topic_id, title, source_text, mode, explanation_style, detail_level,
        allow_outside_knowledge, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      topicId,
      cleanTitle,
      sourceText.trim(),
      mode,
      explanationStyle,
      detailLevel,
      allowOutsideKnowledge ? 1 : 0,
      now,
      now,
    );
    const rootDocumentBody = mode === 'summary'
      ? `# ${cleanTitle}\n\n## 原始资料\n\n${sourceText.trim() || '尚未添加资料。'}\n\n## 整理目标\n\n忠实提炼资料中的主题、主张、证据、例子与结论，并保留可追溯边界。`
      : `# ${cleanTitle}\n\n## 原始目标或资料\n\n${sourceText.trim() || '尚未添加资料。'}\n\n## 我希望掌握什么\n\n能够用自己的语言解释它，并连接到已经掌握的知识。`;
    await transaction.runAsync(
      'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      documentId,
      projectId,
      `目标/${safePath(cleanTitle)}.md`,
      cleanTitle,
      rootDocumentBody,
      'source',
      now,
      now,
    );
    await transaction.runAsync(
      'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      nodeId,
      projectId,
      cleanTitle,
      '目标知识',
      516,
      120,
      10,
      'essential',
      0,
      documentId,
    );
  });

  return { projectId, rootNodeId: nodeId };
}

export async function updateProjectContentPolicy(
  db: SQLiteDatabase,
  projectId: string,
  contentPolicy: ProjectContentPolicy,
) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<{ mode: ProjectMode; node_count: number }>(
      `SELECT p.mode, (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id) AS node_count
       FROM projects p WHERE p.id = ?`,
      projectId,
    );
    if (!row) throw new Error('当前项目不存在');
    if (row.mode !== contentPolicy.mode && row.node_count > 1) {
      throw new Error('已有图谱不能原地切换模式；请创建模式副本后重新分析');
    }
    const result = await transaction.runAsync(
      `UPDATE projects
       SET mode = ?, explanation_style = ?, detail_level = ?,
           allow_outside_knowledge = ?, updated_at = ?
       WHERE id = ?`,
      contentPolicy.mode,
      contentPolicy.explanationStyle,
      contentPolicy.detailLevel,
      contentPolicy.allowOutsideKnowledge ? 1 : 0,
      new Date().toISOString(),
      projectId,
    );
    if (result.changes !== 1) throw new Error('内容设置没有保存');
  });
}

export async function deleteProject(db: SQLiteDatabase, projectId: string) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await assertNoFavoriteDependencies(transaction, { projectId });
    const fusion = await transaction.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='node_documents'");
    if (fusion) {
      await transaction.runAsync('DELETE FROM conversation_documents WHERE document_id IN (SELECT id FROM documents WHERE project_id=?)',projectId);
      await transaction.runAsync('DELETE FROM conversations WHERE project_id=?',projectId);
    }
    await transaction.runAsync('DELETE FROM edges WHERE project_id=?',projectId);
    await transaction.runAsync('DELETE FROM nodes WHERE project_id=?',projectId);
    if (await transaction.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='source_items'")) await transaction.runAsync('DELETE FROM source_items WHERE project_id=?',projectId);
    await transaction.runAsync('DELETE FROM documents WHERE project_id=?',projectId);
    const result = await transaction.runAsync('DELETE FROM projects WHERE id = ?', projectId);
    if (result.changes !== 1) throw new Error('学习项目不存在或已经删除');
  });
}

export async function buildExpansionContext(
  db: SQLiteDatabase,
  nodeId: string,
  prompt: string,
  requestId: string,
): Promise<ExpansionContext> {
  const parent = await db.getFirstAsync<NodeRow>('SELECT * FROM nodes WHERE id = ?', nodeId);
  if (!parent) throw new Error('当前节点不存在');
  const graph = await getGraph(db, parent.project_id);
  const document = await getDocument(db, parent.document_id);
  if (!graph || !document) throw new Error('无法建立展开上下文');
  const incidentEdges = graph.edges
    .filter((edge) => edge.sourceId === parent.id || edge.targetId === parent.id)
    .sort((a, b) => b.importance - a.importance);
  const neighborIds = new Set(incidentEdges.map((edge) => edge.sourceId === parent.id ? edge.targetId : edge.sourceId));
  const maxDocumentLength = 10_000;
  const maxSourceLength = 12_000;
  const maxPromptLength = 2_000;
  const maxRelatedDocuments = 6;
  const maxRelatedDocumentLength = 1_800;
  const maxRecentAnswers = 2;
  const maxRecentAnswerLength = 2_500;
  const cleanPrompt = prompt.trim() || `继续拆解 ${parent.title}`;
  const projectSource = await selectProjectSourceContext(
    db,
    graph.project.id,
    graph.project.sourceText,
    `${cleanPrompt}\n${parent.title}\n${parent.subtitle}`,
    maxSourceLength,
  );
  const pathResult = buildLearningPath(graph, parent.id);
  const relatedKnowledge = await Promise.all(incidentEdges.slice(0, maxRelatedDocuments).map(async (edge) => {
    const neighborId = edge.sourceId === parent.id ? edge.targetId : edge.sourceId;
    const neighbor = graph.nodes.find((node) => node.id === neighborId)!;
    const neighborDocument = await getDocument(db, neighbor.documentId);
    const body = neighborDocument?.body ?? '';
    return {
      id: neighbor.id,
      title: neighbor.title,
      importance: neighbor.importance,
      status: neighbor.status,
      relation: edge.relation,
      direction: edge.sourceId === parent.id ? 'outgoing' as const : 'incoming' as const,
      document: {
        title: neighborDocument?.title ?? neighbor.title,
        body: body.slice(0, maxRelatedDocumentLength),
        origin: neighborDocument?.origin ?? 'ai' as const,
        truncated: body.length > maxRelatedDocumentLength,
      },
    };
  }));
  const allAnswers = await listNodeAnswers(db, parent.id);
  const recentAnswers = allAnswers.slice(0, maxRecentAnswers).map((answer) => ({
    question: answer.question,
    body: answer.body.slice(0, maxRecentAnswerLength),
    source: answer.adapter,
    createdAt: answer.createdAt,
    truncated: answer.body.length > maxRecentAnswerLength,
  }));
  const context: ExpansionContext = {
    requestId,
    schemaVersion: 2,
    project: {
      id: graph.project.id,
      title: graph.project.title,
      sourceText: projectSource.text,
      sourceTextTruncated: projectSource.truncated,
      contentPolicy: graph.project.contentPolicy,
      sourceReferences: projectSource.references,
    },
    selection: {
      kind: 'node',
      id: parent.id,
      title: parent.title,
      subtitle: parent.subtitle,
      importance: parent.importance,
      status: parent.status,
      document: {
        path: document.path,
        title: document.title,
        body: document.body.slice(0, maxDocumentLength),
        origin: document.origin,
        truncated: document.body.length > maxDocumentLength,
      },
    },
    nearbyNodes: graph.nodes
      .filter((node) => neighborIds.has(node.id))
      .slice(0, 12)
      .map((node) => ({
        id: node.id,
        title: node.title,
        importance: node.importance,
        status: node.status,
      })),
    learningPath: pathResult.nodes.map((node, index) => ({
      id: node.id,
      title: node.title,
      importance: node.importance,
      status: node.status,
      viaRelation: index === 0 ? null : pathResult.relations[index - 1] ?? null,
    })),
    relatedKnowledge,
    recentAnswers,
    prompt: cleanPrompt.slice(0, maxPromptLength),
    promptTruncated: cleanPrompt.length > maxPromptLength,
    contextManifest: { totalCharacters: 0, sections: [] },
    constraints: {
      maxNodes: 8,
      maxEdges: 12,
      allowedRelations: resolveContentContract(graph.project.contentPolicy).allowedRelations,
      targetMustBeNewNode: true,
    },
  };
  context.contextManifest.sections = [
    section('projectSource', '项目目标与原始资料', context.project.sourceText.length, context.project.sourceTextTruncated),
    section('selectionDocument', '当前节点 Markdown', context.selection.document.body.length, context.selection.document.truncated),
    section('learningPath', '当前学习路径', JSON.stringify(context.learningPath).length, pathResult.truncated),
    section('relatedKnowledge', '直接相关知识与关系', JSON.stringify(context.relatedKnowledge).length, incidentEdges.length > maxRelatedDocuments || context.relatedKnowledge.some((item) => item.document.truncated)),
    section('recentAnswers', '这个节点最近的回答', JSON.stringify(context.recentAnswers).length, allAnswers.length > maxRecentAnswers || context.recentAnswers.some((item) => item.truncated)),
    section('prompt', '本次问题', context.prompt.length, context.promptTruncated),
  ];
  context.contextManifest.totalCharacters = context.contextManifest.sections.reduce((total, item) => total + item.characters, 0);
  return context;
}

export async function commitGraphPatch(
  db: SQLiteDatabase,
  context: ExpansionContext,
  patch: GraphPatch,
  jobId: string,
  answer: { adapter: ExpansionAdapter; actualModel: string | null; body: string },
) {
  const parent = await db.getFirstAsync<NodeRow>('SELECT * FROM nodes WHERE id = ?', context.selection.id);
  if (!parent) throw new Error('当前节点不存在');

  const existingStats = await db.getFirstAsync<{ count: number; max_y: number }>(
    'SELECT COUNT(*) AS count, COALESCE(MAX(y), 0) AS max_y FROM nodes WHERE project_id = ?',
    parent.project_id,
  );
  const nextOrder = existingStats?.count ?? 0;
  const expansionY = Math.max(parent.y + 220, (existingStats?.max_y ?? parent.y) + 180);
  const now = new Date().toISOString();
  const nodeIds = new Map<string, string>();
  const nodeTitles = new Map<string, string>([['selection', parent.title]]);
  patch.nodes.forEach((node) => {
    nodeIds.set(node.clientId, createId('node'));
    nodeTitles.set(node.clientId, node.title);
  });
  const answerId = createId('answer');
  const batchId = createId('batch');
  const createdNodeIds: string[] = [];
  const createdEdgeIds: string[] = [];
  const createdDocumentIds: string[] = [];
  const nodeFingerprints: GraphMutationFingerprints['nodes'] = [];
  const edgeFingerprints: GraphMutationFingerprints['edges'] = [];

  await db.withExclusiveTransactionAsync(async (transaction) => {
    for (const [index, node] of patch.nodes.entries()) {
      const nodeId = nodeIds.get(node.clientId)!;
      const documentId = createId('doc');
      createdNodeIds.push(nodeId);
      createdDocumentIds.push(documentId);
      nodeFingerprints.push({
        id: nodeId,
        title: node.title,
        subtitle: node.subtitle,
        importance: node.importance,
        status: node.status,
        documentId,
        documentTitle: node.document.title,
        documentBody: node.document.body,
      });
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? Math.max(60, parent.x - 190) : Math.min(950, parent.x + 210);
      const y = expansionY + row * 190 + column * 24;
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        documentId,
        parent.project_id,
        `探索/${safePath(node.title)}-${nodeId.slice(-5)}.md`,
        node.document.title,
        node.document.body,
        'ai',
        now,
        now,
      );
      await transaction.runAsync(
        'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        nodeId,
        parent.project_id,
        node.title,
        node.subtitle,
        x,
        y,
        node.importance,
        node.status,
        nextOrder + index,
        documentId,
      );
    }

    for (const edge of patch.edges) {
      const edgeId = createId('edge');
      const documentId = createId('doc-edge');
      createdEdgeIds.push(edgeId);
      createdDocumentIds.push(documentId);
      const sourceId = edge.sourceRef === 'selection' ? parent.id : nodeIds.get(edge.sourceRef)!;
      const targetId = nodeIds.get(edge.targetRef)!;
      edgeFingerprints.push({
        id: edgeId,
        sourceId,
        targetId,
        relation: edge.relation,
        importance: edge.importance,
        reviewStatus: 'unverified',
        documentId,
        documentTitle: edge.document.title || `${nodeTitles.get(edge.sourceRef)} → ${nodeTitles.get(edge.targetRef)}`,
        documentBody: edge.document.body,
      });
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        documentId,
        parent.project_id,
        `关系/${edgeId}.md`,
        edge.document.title || `${nodeTitles.get(edge.sourceRef)} → ${nodeTitles.get(edge.targetRef)}`,
        edge.document.body,
        'ai',
        now,
        now,
      );
      await transaction.runAsync(
        `INSERT INTO edges (
          id, project_id, source_id, target_id, relation, effective_relation, importance, document_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        edgeId,
        parent.project_id,
        sourceId,
        targetId,
        edge.relation === 'contains' ? 'support' : edge.relation,
        edge.relation === 'contains' ? 'contains' : null,
        edge.importance,
        documentId,
      );
    }
    await reflowProjectGraphInTransaction(transaction, parent.project_id);
    await transaction.runAsync('UPDATE projects SET updated_at = ? WHERE id = ?', now, parent.project_id);
    await insertNodeAnswerInTransaction(transaction, {
      id: answerId,
      projectId: parent.project_id,
      nodeId: parent.id,
      jobId,
      question: context.prompt,
      body: answer.body,
      adapter: answer.adapter,
      actualModel: answer.actualModel,
    });
    const sourceReferences = context.project.sourceReferences ?? [];
    const citationTargets = [
      { type: 'answer', id: answerId },
      ...createdNodeIds.map((id) => ({ type: 'node', id })),
      ...createdEdgeIds.map((id) => ({ type: 'edge', id })),
      ...createdDocumentIds.map((id) => ({ type: 'document', id })),
    ] as const;
    for (const target of citationTargets) {
      for (const reference of sourceReferences) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO source_citations (
            id, project_id, target_type, target_id, source_item_id, locator, quote, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
          createId('citation'),
          parent.project_id,
          target.type,
          target.id,
          reference.sourceItemId,
          reference.locator,
          now,
        );
      }
    }
    await transaction.runAsync(
      `INSERT INTO graph_mutation_batches (
        id, project_id, selection_id, job_id, answer_id, status,
        created_node_ids_json, created_edge_ids_json, created_document_ids_json,
        object_fingerprints_json, committed_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, NULL)`,
      batchId,
      parent.project_id,
      parent.id,
      jobId,
      answerId,
      JSON.stringify(createdNodeIds),
      JSON.stringify(createdEdgeIds),
      JSON.stringify(createdDocumentIds),
      JSON.stringify({ version: 1, nodes: nodeFingerprints, edges: edgeFingerprints }),
      now,
    );
    await markExpansionSucceededInTransaction(transaction, jobId, patch);
  });
  return { nodeCount: patch.nodes.length, edgeCount: patch.edges.length, answerId, batchId };
}

export async function undoGraphMutationBatch(db: SQLiteDatabase, batchId: string) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<{
      id: string;
      project_id: string;
      answer_id: string;
      status: 'applied' | 'undone';
      created_node_ids_json: string;
      created_edge_ids_json: string;
      created_document_ids_json: string;
      object_fingerprints_json: string;
    }>('SELECT * FROM graph_mutation_batches WHERE id = ?', batchId);
    if (!row) throw new Error('这次修改记录不存在');
    if (row.status === 'undone') return;
    const nodeIds = parseIdList(row.created_node_ids_json);
    const edgeIds = parseIdList(row.created_edge_ids_json);
    const documentIds = parseIdList(row.created_document_ids_json);
    const fingerprints = parseGraphMutationFingerprints(row.object_fingerprints_json);
    await assertGraphMutationObjectsUnchanged(transaction, fingerprints);
    const fusion = await transaction.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='node_documents'");
    if (fusion) {
      for (const nodeId of nodeIds) {
        if (await transaction.getFirstAsync('SELECT 1 FROM conversations WHERE node_id=? UNION ALL SELECT 1 FROM conversation_documents WHERE node_id=? UNION ALL SELECT 1 FROM node_documents l JOIN nodes n ON n.id=l.node_id WHERE n.id=? AND l.document_id<>n.document_id LIMIT 1',nodeId,nodeId,nodeId)) throw new Error('这些节点后来产生了讨论、保存来源或附加文档，不能整批撤销');
      }
      for (const documentId of documentIds) {
        const links=await transaction.getAllAsync<{node_id:string}>('SELECT node_id FROM node_documents WHERE document_id=?',documentId);
        if (links.some(link=>!nodeIds.includes(link.node_id)) || await transaction.getFirstAsync('SELECT 1 FROM conversation_documents WHERE document_id=?',documentId)) throw new Error('本次文档后来已被其他内容引用，不能整批撤销');
      }
    }
    if (nodeIds.length) {
      const placeholders = nodeIds.map(() => '?').join(',');
      const dependency = await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM edges
         WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
           AND id NOT IN (${edgeIds.length ? edgeIds.map(() => '?').join(',') : "''"})`,
        ...nodeIds,
        ...nodeIds,
        ...edgeIds,
      );
      if ((dependency?.count ?? 0) > 0) {
        throw new Error('这些新节点后来又连接了其他内容，不能整批撤销；请先处理后续关系');
      }
      const activeJob = await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ai_expansion_jobs
         WHERE selection_id IN (${placeholders}) AND status IN ('queued', 'running', 'retry_wait')`,
        ...nodeIds,
      );
      if ((activeJob?.count ?? 0) > 0) throw new Error('新节点上仍有 AI 任务，当前不能撤销');
      const favorite = await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM favorites WHERE node_id IN (${placeholders})`,
        ...nodeIds,
      );
      if ((favorite?.count ?? 0) > 0) throw new Error('本次内容仍被收藏引用，请先移除相关收藏');
      const mastery = await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM mastery_attempts WHERE node_id IN (${placeholders})`,
        ...nodeIds,
      );
      if ((mastery?.count ?? 0) > 0) throw new Error('这些新节点已经产生掌握记录，不能整批撤销');
    }
    if (edgeIds.length) {
      await transaction.runAsync(
        `DELETE FROM edges WHERE id IN (${edgeIds.map(() => '?').join(',')})`,
        ...edgeIds,
      );
    }
    if (nodeIds.length) {
      await transaction.runAsync(
        `DELETE FROM nodes WHERE id IN (${nodeIds.map(() => '?').join(',')})`,
        ...nodeIds,
      );
    }
    for (const documentId of documentIds) {
      await transaction.runAsync(
        `DELETE FROM documents
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM nodes WHERE document_id = ?)
           AND NOT EXISTS (SELECT 1 FROM edges WHERE document_id = ?)
           AND NOT EXISTS (SELECT 1 FROM source_items WHERE derived_document_id = ?)`,
        documentId,
        documentId,
        documentId,
        documentId,
      );
    }
    await cleanDeletedCitations(transaction,{node:nodeIds,edge:edgeIds,document:documentIds});
    await transaction.runAsync(
      `UPDATE graph_mutation_batches SET status = 'undone', undone_at = ? WHERE id = ?`,
      new Date().toISOString(),
      batchId,
    );
    await reflowProjectGraphInTransaction(transaction, row.project_id);
    await transaction.runAsync(
      'UPDATE projects SET updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      row.project_id,
    );
  });
}

async function cleanDeletedCitations(db:SQLiteDatabase,targets:Partial<Record<'node'|'edge'|'document'|'answer',string[]>>) {
  if (!await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='source_citations'")) return;
  const tables={node:'nodes',edge:'edges',document:'documents',answer:'node_answers'} as const;
  for(const kind of Object.keys(targets) as (keyof typeof tables)[]) {
    for(const id of targets[kind]??[]) await db.runAsync(`DELETE FROM source_citations WHERE target_type=? AND target_id=? AND NOT EXISTS(SELECT 1 FROM ${tables[kind]} WHERE id=?)`,kind,id,id);
  }
}

export async function getLatestAppliedGraphMutationBatch(
  db: SQLiteDatabase,
  projectId: string,
): Promise<GraphMutationBatch | null> {
  const row = await db.getFirstAsync<{
    id: string;
    project_id: string;
    selection_id: string;
    job_id: string;
    answer_id: string;
    status: 'applied' | 'undone';
    created_node_ids_json: string;
    created_edge_ids_json: string;
    created_document_ids_json: string;
    committed_at: string;
    undone_at: string | null;
  }>(
    `SELECT id, project_id, selection_id, job_id, answer_id, status,
            created_node_ids_json, created_edge_ids_json, created_document_ids_json,
            committed_at, undone_at
     FROM graph_mutation_batches
     WHERE project_id = ? AND status = 'applied'
     ORDER BY committed_at DESC, rowid DESC
     LIMIT 1`,
    projectId,
  );
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    selectionId: row.selection_id,
    jobId: row.job_id,
    answerId: row.answer_id,
    status: row.status,
    createdNodeIds: parseIdList(row.created_node_ids_json),
    createdEdgeIds: parseIdList(row.created_edge_ids_json),
    createdDocumentIds: parseIdList(row.created_document_ids_json),
    committedAt: row.committed_at,
    undoneAt: row.undone_at,
  };
}

async function readNodeDeleteImpact(db: SQLiteDatabase, nodeId: string): Promise<NodeDeleteImpact> {
  const node = await db.getFirstAsync<Pick<NodeRow, 'id' | 'project_id' | 'title'>>(
    'SELECT id, project_id, title FROM nodes WHERE id = ?',
    nodeId,
  );
  if (!node) throw new Error('当前节点不存在');
  const root = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM nodes WHERE project_id = ?
     ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, rowid LIMIT 1`,
    node.project_id,
  );
  const project = await db.getFirstAsync<ProjectRow>('SELECT * FROM projects WHERE id=?',node.project_id);
  const counts = await db.getFirstAsync<{ edge_count: number; answer_count: number; favorite_count: number; active_job_count: number }>(
    `SELECT
       (SELECT COUNT(*) FROM edges WHERE source_id = ? OR target_id = ?) AS edge_count,
       (SELECT COUNT(*) FROM node_answers WHERE node_id = ?) AS answer_count,
       (SELECT COUNT(*) FROM favorites WHERE node_id = ?) AS favorite_count,
       (SELECT COUNT(*) FROM ai_expansion_jobs WHERE project_id = ? AND selection_id = ?
         AND status IN ('queued', 'running', 'retry_wait')) AS active_job_count`,
    nodeId,
    nodeId,
    nodeId,
    nodeId,
    node.project_id,
    nodeId,
  );
  return {
    nodeId,
    title: node.title,
    isRoot: project?.graph_kind !== 'free' && root?.id === nodeId,
    edgeCount: counts?.edge_count ?? 0,
    answerCount: counts?.answer_count ?? 0,
    favoriteCount: counts?.favorite_count ?? 0,
    activeJobCount: counts?.active_job_count ?? 0,
  };
}

async function reflowProjectGraphInTransaction(
  db: SQLiteDatabase,
  projectId: string,
  requestedDirection?: LayoutDirection,
) {
  const fullProject = await db.getFirstAsync<ProjectRow>('SELECT * FROM projects WHERE id=?',projectId);
  if (!requestedDirection && fullProject?.graph_kind === 'free') return;
  const nodes = await db.getAllAsync<NodeRow>('SELECT * FROM nodes WHERE project_id = ? ORDER BY sort_order, id', projectId);
  const edges = await db.getAllAsync<EdgeRow>('SELECT * FROM edges WHERE project_id = ? ORDER BY id', projectId);
  const project = requestedDirection
    ? { layout_direction: requestedDirection }
    : await db.getFirstAsync<{ layout_direction: LayoutDirection }>(
      'SELECT layout_direction FROM projects WHERE id = ?',
      projectId,
    );
  const layout = computeHierarchyLayout(nodes.map(mapNode), edges.map(mapEdge), project?.layout_direction ?? 'vertical');
  for (const [nodeId, position] of layout.positions) {
    await db.runAsync('UPDATE nodes SET x = ?, y = ? WHERE id = ?', position.x, position.y, nodeId);
  }
  return layout;
}

function mapProject(row: ProjectRow): LearningProject {
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    sourceText: row.source_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodeCount: row.node_count,
    masteredCount: row.mastered_count,
    layoutDirection: row.layout_direction ?? 'vertical',
    graphKind: row.graph_kind ?? row.mode ?? 'learning',
    contentPolicy: {
      version: 1,
      mode: row.mode ?? 'learning',
      explanationStyle: row.explanation_style ?? 'legacy',
      detailLevel: row.detail_level ?? 'detailed',
      allowOutsideKnowledge: (row.allow_outside_knowledge ?? 1) === 1,
    },
  };
}

function mapDocument(row: DocumentRow): MarkdownDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    title: row.title,
    body: row.body,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    subtitle: row.subtitle,
    x: row.x,
    y: row.y,
    importance: row.importance,
    status: row.status,
    order: row.sort_order,
    documentId: row.document_id,
  };
}

function mapEdge(row: EdgeRow): KnowledgeEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.effective_relation ?? row.relation,
    importance: row.importance,
    documentId: row.document_id,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    relationKind: row.relation_kind ?? null,
    directed: row.directed !== 0,
    label: row.label ?? '',
  };
}

function buildLearningPath(graph: KnowledgeGraph, targetId: string) {
  const root = [...graph.nodes].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))[0];
  if (!root || root.id === targetId) return { nodes: root ? [root] : [], relations: [] as KnowledgeEdge['relation'][], truncated: false };
  const previous = new Map<string, { nodeId: string; relation: KnowledgeEdge['relation'] }>();
  const queue = [root.id];
  const visited = new Set(queue);
  while (queue.length) {
    const sourceId = queue.shift()!;
    for (const edge of graph.edges.filter((item) => item.sourceId === sourceId)) {
      if (visited.has(edge.targetId)) continue;
      visited.add(edge.targetId);
      previous.set(edge.targetId, { nodeId: sourceId, relation: edge.relation });
      queue.push(edge.targetId);
    }
  }
  if (!visited.has(targetId)) {
    const selected = graph.nodes.find((node) => node.id === targetId);
    return { nodes: selected ? [selected] : [], relations: [] as KnowledgeEdge['relation'][], truncated: false };
  }
  const reversedIds = [targetId];
  const reversedRelations: KnowledgeEdge['relation'][] = [];
  let cursor = targetId;
  while (cursor !== root.id) {
    const step = previous.get(cursor);
    if (!step) break;
    reversedRelations.push(step.relation);
    cursor = step.nodeId;
    reversedIds.push(cursor);
  }
  const ids = reversedIds.reverse();
  const relations = reversedRelations.reverse();
  const maxPathNodes = 8;
  const truncated = ids.length > maxPathNodes;
  const keptIds = truncated ? ids.slice(-maxPathNodes) : ids;
  const keptRelations = truncated ? relations.slice(-(maxPathNodes - 1)) : relations;
  return {
    nodes: keptIds.map((id) => graph.nodes.find((node) => node.id === id)!).filter(Boolean),
    relations: keptRelations,
    truncated,
  };
}

async function selectProjectSourceContext(
  db: SQLiteDatabase,
  projectId: string,
  initialSource: string,
  query: string,
  maxCharacters: number,
) {
  const rows = await db.getAllAsync<{
    item_id: string;
    title: string;
    kind: string;
    source_url: string | null;
    created_at: string;
    ordinal: number;
    locator: string;
    body: string;
  }>(
    `SELECT item.id AS item_id, item.title, item.kind, item.source_url, item.created_at,
            segment.ordinal, segment.locator, segment.body
     FROM source_items item
     JOIN source_segments segment ON segment.source_item_id = item.id
     WHERE item.project_id = ? AND item.extraction_status = 'ready'
     ORDER BY item.created_at, item.id, segment.ordinal
     LIMIT 400`,
    projectId,
  );
  const terms = contextTerms(query);
  const ranked = rows
    .map((row, sourceOrder) => ({
      ...row,
      sourceOrder,
      score: sourceSegmentScore(terms, `${row.title}\n${row.locator}\n${row.body}`),
    }))
    .sort((left, right) => right.score - left.score || left.sourceOrder - right.sourceOrder);
  const chunks: string[] = [];
  const references: Array<{ sourceItemId: string; title: string; locator: string }> = [];
  const referenceKeys = new Set<string>();
  let remaining = maxCharacters;
  let omitted = false;
  const cleanInitial = initialSource.trim();
  if (cleanInitial) {
    const header = '### 项目最初输入\n\n';
    const allowed = Math.max(0, remaining - header.length);
    const body = cleanInitial.slice(0, allowed);
    chunks.push(`${header}${body}`);
    remaining -= header.length + body.length;
    omitted ||= body.length < cleanInitial.length;
  }
  let includedSourceSegments = 0;
  for (const row of ranked) {
    if (remaining < 160) {
      omitted = true;
      break;
    }
    const location = [row.locator, row.source_url].filter(Boolean).join(' · ');
    const header = `### 来源：${row.title}（${row.kind}${location ? ` · ${location}` : ''}）\n\n`;
    const allowed = Math.min(2_400, Math.max(0, remaining - header.length));
    if (allowed < 80) {
      omitted = true;
      break;
    }
    const body = row.body.slice(0, allowed);
    chunks.push(`${header}${body}`);
    remaining -= header.length + body.length;
    includedSourceSegments += 1;
    const referenceKey = `${row.item_id}\u0000${row.locator}`;
    if (!referenceKeys.has(referenceKey)) {
      referenceKeys.add(referenceKey);
      references.push({
        sourceItemId: row.item_id,
        title: row.title,
        locator: row.locator,
      });
    }
    omitted ||= body.length < row.body.length;
  }
  return {
    text: chunks.join('\n\n'),
    truncated: omitted || ranked.length > includedSourceSegments,
    references,
  };
}

function contextTerms(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’]/gu, ' ');
  const words = normalized.match(/[a-z0-9_+-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = new Set<string>();
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 4) {
      for (let index = 0; index <= word.length - 2; index += 1) terms.add(word.slice(index, index + 2));
    } else {
      terms.add(word);
    }
  }
  return [...terms].filter((term) => !['什么', '怎么', '这个', '一下', '可以', '需要'].includes(term));
}

function sourceSegmentScore(terms: string[], value: string) {
  if (!terms.length) return 0;
  const normalized = value.toLocaleLowerCase();
  return terms.reduce((score, term) => (
    score + (normalized.includes(term) ? Math.min(24, 8 + term.length * 2) : 0)
  ), 0);
}

function parseIdList(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('invalid id list');
    }
    return parsed as string[];
  } catch {
    throw new Error('撤销记录损坏，未删除任何内容');
  }
}

type GraphMutationFingerprints = {
  version: 1;
  nodes: Array<{
    id: string;
    title: string;
    subtitle: string;
    importance: number;
    status: KnowledgeStatus;
    documentId: string;
    documentTitle: string;
    documentBody: string;
  }>;
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relation: RelationType;
    importance: number;
    reviewStatus: EdgeReviewStatus;
    documentId: string;
    documentTitle: string;
    documentBody: string;
  }>;
};

function parseGraphMutationFingerprints(value: string): GraphMutationFingerprints {
  try {
    const parsed = JSON.parse(value) as Partial<GraphMutationFingerprints>;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('invalid fingerprints');
    }
    return parsed as GraphMutationFingerprints;
  } catch {
    throw new Error('撤销校验记录损坏，未删除任何内容');
  }
}

async function assertGraphMutationObjectsUnchanged(
  transaction: SQLiteDatabase,
  fingerprints: GraphMutationFingerprints,
) {
  for (const expected of fingerprints.nodes) {
    const current = await transaction.getFirstAsync<{
      id: string;
      title: string;
      subtitle: string;
      importance: number;
      status: KnowledgeStatus;
      document_id: string;
      document_title: string;
      document_body: string;
    }>(
      `SELECT n.id, n.title, n.subtitle, n.importance, n.status, n.document_id,
              d.title AS document_title, d.body AS document_body
       FROM nodes n JOIN documents d ON d.id = n.document_id
       WHERE n.id = ?`,
      expected.id,
    );
    if (
      !current
      || current.title !== expected.title
      || current.subtitle !== expected.subtitle
      || current.importance !== expected.importance
      || current.status !== expected.status
      || current.document_id !== expected.documentId
      || current.document_title !== expected.documentTitle
      || current.document_body !== expected.documentBody
    ) {
      throw new Error('本次新增节点后来已被修改，不能整批撤销');
    }
  }
  for (const expected of fingerprints.edges) {
    const current = await transaction.getFirstAsync<{
      id: string;
      source_id: string;
      target_id: string;
      relation: RelationType;
      importance: number;
      review_status: EdgeReviewStatus;
      document_id: string;
      document_title: string;
      document_body: string;
    }>(
      `SELECT e.id, e.source_id, e.target_id, COALESCE(e.effective_relation, e.relation) AS relation,
              e.importance, e.review_status, e.document_id,
              d.title AS document_title, d.body AS document_body
       FROM edges e JOIN documents d ON d.id = e.document_id
       WHERE e.id = ?`,
      expected.id,
    );
    if (
      !current
      || current.source_id !== expected.sourceId
      || current.target_id !== expected.targetId
      || current.relation !== expected.relation
      || current.importance !== expected.importance
      || current.review_status !== expected.reviewStatus
      || current.document_id !== expected.documentId
      || current.document_title !== expected.documentTitle
      || current.document_body !== expected.documentBody
    ) {
      throw new Error('本次新增关系后来已被修改，不能整批撤销');
    }
  }
}

function section(
  key: ExpansionContext['contextManifest']['sections'][number]['key'],
  label: string,
  characters: number,
  truncated: boolean,
) {
  return { key, label, characters, truncated };
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function safePath(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').slice(0, 48);
}
