import type { SQLiteDatabase } from 'expo-sqlite';
import { remapReadingReferences } from './reading-reference';

import { insertNodeAnswerInTransaction } from '@/data/node-answers';
import { exportPortableFusion, importPortableFusion, validatePortableFusion, type PortableFusion } from './portable-fusion';
import type {
  DocumentOrigin,
  EdgeReviewStatus,
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeStatus,
  RelationType,
  LayoutDirection,
  ProjectContentPolicy,
  SourceItemKind,
  MasteryAttempt,
  GraphMutationBatch,
} from '@/types/domain';

export const PORTABLE_FORMAT = 'learnstuff-graph' as const;
export const PORTABLE_VERSION = 3 as const;
export const MAX_MARKDOWN_FILES = 120;
export const MAX_MARKDOWN_FILE_CHARS = 1_000_000;
export const MAX_MARKDOWN_TOTAL_CHARS = 12_000_000;
export const MAX_MANIFEST_CHARS = 24_000_000;

const MAX_DOCUMENTS = 2_500;
const MAX_NODES = 500;
const MAX_EDGES = 1_500;
const MAX_ANSWERS = 500;
const MAX_SOURCE_ITEMS = 500;
const MAX_SOURCE_SEGMENTS = 5_000;
const MAX_MASTERY_ATTEMPTS = 5_000;
const MAX_GRAPH_BATCHES = 2_000;
const MAX_SOURCE_CITATIONS = 20_000;

export type ImportedMarkdownFile = { relativePath: string; body: string };

export type PortableGraphManifest = {
  format: typeof PORTABLE_FORMAT;
  version: 1 | 2 | typeof PORTABLE_VERSION;
  exportedAt: string;
  project: {
    id: string;
    topicId?: string | null;
    title: string;
    sourceText: string;
    createdAt: string;
    updatedAt: string;
    layoutDirection?: LayoutDirection;
    contentPolicy?: ProjectContentPolicy;
  };
  documents: Array<{
    id: string;
    path: string;
    title: string;
    body: string;
    origin: DocumentOrigin;
    createdAt: string;
    updatedAt: string;
  }>;
  nodes: Array<Omit<KnowledgeNode, 'projectId'>>;
  edges: Array<Omit<KnowledgeEdge, 'projectId'>>;
  savedAnswers: Array<{
    id: string;
    nodeId: string;
    question: string;
    body: string;
    adapter: 'local' | 'gateway' | 'byok' | 'imported';
    actualModel: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  answers?: Array<{
    id: string;
    nodeId: string;
    question: string;
    body: string;
    adapter: 'local' | 'gateway' | 'byok' | 'imported';
    actualModel: string | null;
    saved: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  sourceItems?: Array<{
    id: string;
    kind: SourceItemKind;
    title: string;
    originalName: string | null;
    mediaType: string;
    sourceUrl: string | null;
    contentHash: string;
    byteSize: number;
    extractionStatus?: 'ready' | 'processing' | 'failed';
    extractionError?: string | null;
    originalAssetIncluded: false;
    derivedDocumentId: string;
    createdAt: string;
    updatedAt: string;
    segments: Array<{
      ordinal: number;
      locatorType: 'text' | 'paragraph' | 'page' | 'image' | 'url';
      locator: string;
      body: string;
      contentHash: string;
    }>;
  }>;
  masteryAttempts?: Array<Omit<MasteryAttempt, 'projectId'>>;
  graphMutationBatches?: Array<Omit<GraphMutationBatch, 'projectId'>>;
  sourceCitations?: Array<{
    id: string;
    targetType: 'node' | 'edge' | 'answer' | 'document';
    targetId: string;
    sourceItemId: string;
    locator: string;
    quote: string;
    createdAt: string;
  }>;
  fusion?: PortableFusion;
};

type DocumentRow = PortableGraphManifest['documents'][number] & { project_id?: string };

export async function createPortableManifest(
  db: SQLiteDatabase,
  projectId: string,
): Promise<PortableGraphManifest> {
  const project = await db.getFirstAsync<{
    id: string; topic_id: string | null; title: string; source_text: string; created_at: string; updated_at: string; layout_direction: LayoutDirection;
    mode: ProjectContentPolicy['mode']; explanation_style: ProjectContentPolicy['explanationStyle'];
    detail_level: ProjectContentPolicy['detailLevel']; allow_outside_knowledge: number;
  }>('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new Error('项目不存在或已经删除');
  const [
    documents,
    nodes,
    edges,
    answers,
    sourceItems,
    sourceSegments,
    masteryAttempts,
    graphBatches,
    sourceCitations,
  ] = await Promise.all([
    db.getAllAsync<{
      id: string; path: string; title: string; body: string; origin: DocumentOrigin; created_at: string; updated_at: string;
    }>('SELECT id, path, title, body, origin, created_at, updated_at FROM documents WHERE project_id = ? ORDER BY path', projectId),
    db.getAllAsync<{
      id: string; title: string; subtitle: string; x: number; y: number; importance: number; status: KnowledgeStatus;
      sort_order: number | null; document_id: string;
    }>('SELECT id, title, subtitle, x, y, importance, status, sort_order, document_id FROM nodes WHERE project_id = ? ORDER BY sort_order, id', projectId),
    db.getAllAsync<{
      id: string; source_id: string; target_id: string; relation: RelationType; importance: number; document_id: string;
      review_status: EdgeReviewStatus; reviewed_at: string | null;
    }>('SELECT id, source_id, target_id, COALESCE(effective_relation, relation) AS relation, importance, document_id, review_status, reviewed_at FROM edges WHERE project_id = ? ORDER BY id', projectId),
    db.getAllAsync<{
      id: string; node_id: string; question: string; body: string; adapter: PortableGraphManifest['savedAnswers'][number]['adapter'];
      actual_model: string | null; created_at: string; updated_at: string;
      is_saved: number;
    }>('SELECT id, node_id, question, body, adapter, actual_model, is_saved, created_at, updated_at FROM node_answers WHERE project_id = ? ORDER BY created_at, id', projectId),
    db.getAllAsync<{
      id: string; kind: SourceItemKind; title: string; original_name: string | null; media_type: string;
      source_url: string | null; content_hash: string; byte_size: number;
      extraction_status: 'ready' | 'processing' | 'failed'; extraction_error: string | null; derived_document_id: string;
      created_at: string; updated_at: string;
    }>('SELECT id, kind, title, original_name, media_type, source_url, content_hash, byte_size, extraction_status, extraction_error, derived_document_id, created_at, updated_at FROM source_items WHERE project_id = ? ORDER BY created_at, id', projectId),
    db.getAllAsync<{
      source_item_id: string; ordinal: number; locator_type: 'text' | 'paragraph' | 'page' | 'image' | 'url';
      locator: string; body: string; content_hash: string;
    }>(`SELECT segment.source_item_id, segment.ordinal, segment.locator_type, segment.locator, segment.body, segment.content_hash
       FROM source_segments segment JOIN source_items item ON item.id = segment.source_item_id
       WHERE item.project_id = ? ORDER BY segment.source_item_id, segment.ordinal`, projectId),
    db.getAllAsync<{
      id: string; node_id: string; question: string; learner_answer: string; reference_points: string;
      decision: MasteryAttempt['decision']; created_at: string;
    }>('SELECT id, node_id, question, learner_answer, reference_points, decision, created_at FROM mastery_attempts WHERE project_id = ? ORDER BY created_at, id', projectId),
    db.getAllAsync<{
      id: string; selection_id: string; job_id: string; answer_id: string; status: GraphMutationBatch['status'];
      created_node_ids_json: string; created_edge_ids_json: string; created_document_ids_json: string;
      committed_at: string; undone_at: string | null;
    }>(`SELECT id, selection_id, job_id, answer_id, status,
              created_node_ids_json, created_edge_ids_json, created_document_ids_json,
              committed_at, undone_at
       FROM graph_mutation_batches WHERE project_id = ? ORDER BY committed_at, id`, projectId),
    db.getAllAsync<{
      id: string; target_type: 'node' | 'edge' | 'answer' | 'document'; target_id: string;
      source_item_id: string; locator: string; quote: string; created_at: string;
    }>('SELECT id, target_type, target_id, source_item_id, locator, quote, created_at FROM source_citations WHERE project_id = ? ORDER BY created_at, id', projectId),
  ]);
  return validatePortableManifest({
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: new Date().toISOString(),
    fusion: await exportPortableFusion(db, projectId),
    project: {
      id: project.id,
      topicId: project.topic_id,
      title: project.title,
      sourceText: project.source_text,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      layoutDirection: project.layout_direction ?? 'vertical',
      contentPolicy: {
        version: 1,
        mode: project.mode ?? 'learning',
        explanationStyle: project.explanation_style ?? 'legacy',
        detailLevel: project.detail_level ?? 'detailed',
        allowOutsideKnowledge: (project.allow_outside_knowledge ?? 1) === 1,
      },
    },
    documents: documents.map((document) => ({
      id: document.id,
      path: document.path,
      title: document.title,
      body: document.body,
      origin: document.origin,
      createdAt: document.created_at,
      updatedAt: document.updated_at,
    })),
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      subtitle: node.subtitle,
      x: node.x,
      y: node.y,
      importance: node.importance,
      status: node.status,
      order: node.sort_order,
      documentId: node.document_id,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.source_id,
      targetId: edge.target_id,
      relation: edge.relation,
      importance: edge.importance,
      documentId: edge.document_id,
      reviewStatus: edge.review_status,
      reviewedAt: edge.reviewed_at,
    })),
    savedAnswers: answers.filter((answer) => answer.is_saved === 1).map((answer) => ({
      id: answer.id,
      nodeId: answer.node_id,
      question: answer.question,
      body: answer.body,
      adapter: answer.adapter,
      actualModel: answer.actual_model,
      createdAt: answer.created_at,
      updatedAt: answer.updated_at,
    })),
    answers: answers.map((answer) => ({
      id: answer.id,
      nodeId: answer.node_id,
      question: answer.question,
      body: answer.body,
      adapter: answer.adapter,
      actualModel: answer.actual_model,
      saved: answer.is_saved === 1,
      createdAt: answer.created_at,
      updatedAt: answer.updated_at,
    })),
    sourceItems: sourceItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      originalName: item.original_name,
      mediaType: item.media_type,
      sourceUrl: item.source_url,
      contentHash: item.content_hash,
      byteSize: item.byte_size,
      extractionStatus: item.extraction_status,
      extractionError: item.extraction_error,
      originalAssetIncluded: false,
      derivedDocumentId: item.derived_document_id,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      segments: sourceSegments
        .filter((segment) => segment.source_item_id === item.id)
        .map((segment) => ({
          ordinal: segment.ordinal,
          locatorType: segment.locator_type,
          locator: segment.locator,
          body: segment.body,
          contentHash: segment.content_hash,
        })),
    })),
    masteryAttempts: masteryAttempts.map((attempt) => ({
      id: attempt.id,
      nodeId: attempt.node_id,
      question: attempt.question,
      learnerAnswer: attempt.learner_answer,
      referencePoints: attempt.reference_points,
      decision: attempt.decision,
      createdAt: attempt.created_at,
    })),
    graphMutationBatches: graphBatches.map((batch) => ({
      id: batch.id,
      selectionId: batch.selection_id,
      jobId: batch.job_id,
      answerId: batch.answer_id,
      status: batch.status,
      createdNodeIds: parseStoredIdList(batch.created_node_ids_json),
      createdEdgeIds: parseStoredIdList(batch.created_edge_ids_json),
      createdDocumentIds: parseStoredIdList(batch.created_document_ids_json),
      committedAt: batch.committed_at,
      undoneAt: batch.undone_at,
    })),
    sourceCitations: sourceCitations.map((citation) => ({
      id: citation.id,
      targetType: citation.target_type,
      targetId: citation.target_id,
      sourceItemId: citation.source_item_id,
      locator: citation.locator,
      quote: citation.quote,
      createdAt: citation.created_at,
    })),
  });
}

export function parsePortableManifest(raw: string): PortableGraphManifest {
  if (raw.length > MAX_MANIFEST_CHARS) throw new Error('图谱文件超过 24 MB 上限');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('learnstuff.graph.json 不是有效 JSON');
  }
  return validatePortableManifest(parsed);
}

export function validatePortableManifest(value: unknown): PortableGraphManifest {
  const manifest = record(value, '图谱清单');
  if (manifest.format !== PORTABLE_FORMAT || (manifest.version !== 1 && manifest.version !== 2 && manifest.version !== PORTABLE_VERSION)) {
    throw new Error('不是受支持的 LearnStuff 图谱格式 v1/v2/v3');
  }
  const project = record(manifest.project, '项目信息');
  const rawContentPolicy = project.contentPolicy === undefined
    ? null
    : record(project.contentPolicy, '内容策略');
  const contentPolicy: ProjectContentPolicy = rawContentPolicy
    ? {
        version: 1,
        mode: oneOf(rawContentPolicy.mode, ['learning', 'summary'] as const, '图谱模式'),
        explanationStyle: oneOf(rawContentPolicy.explanationStyle, ['legacy', 'plain_language'] as const, '讲解风格'),
        detailLevel: oneOf(rawContentPolicy.detailLevel, ['one_sentence', 'concise', 'detailed', 'deep'] as const, '内容长度'),
        allowOutsideKnowledge: booleanValue(rawContentPolicy.allowOutsideKnowledge, '资料外知识设置'),
      }
    : {
        version: 1,
        mode: 'learning',
        explanationStyle: 'legacy',
        detailLevel: 'detailed',
        allowOutsideKnowledge: true,
      };
  const documents = array(manifest.documents, '文档', MAX_DOCUMENTS).map((item, index) => {
    const row = record(item, `文档 ${index + 1}`);
    return {
      id: shortString(row.id, '文档 ID', 160),
      path: safeRelativePath(shortString(row.path, '文档路径', 500)),
      title: shortString(row.title, '文档标题', 300),
      body: bodyString(row.body, '文档正文'),
      origin: oneOf(row.origin, ['source', 'ai', 'learner'] as const, '文档来源'),
      createdAt: shortString(row.createdAt, '文档创建时间', 80),
      updatedAt: shortString(row.updatedAt, '文档更新时间', 80),
    };
  });
  const nodes = array(manifest.nodes, '节点', MAX_NODES).map((item, index) => {
    const row = record(item, `节点 ${index + 1}`);
    return {
      id: shortString(row.id, '节点 ID', 160),
      title: shortString(row.title, '节点标题', 300),
      subtitle: nullableString(row.subtitle, '节点副标题', 500) ?? '',
      x: finiteNumber(row.x, '节点 x'),
      y: finiteNumber(row.y, '节点 y'),
      importance: integerBetween(row.importance, 1, 10, '节点重要度'),
      status: oneOf(row.status, ['essential', 'learning', 'mastered', 'uncertain', 'optional'] as const, '节点状态'),
      order: row.order === null ? null : integerBetween(row.order, -1, 1_000_000, '节点顺序'),
      documentId: shortString(row.documentId, '节点文档 ID', 160),
    };
  });
  const edges = array(manifest.edges, '关系', MAX_EDGES).map((item, index) => {
    const row = record(item, `关系 ${index + 1}`);
    return {
      id: shortString(row.id, '关系 ID', 160),
      sourceId: shortString(row.sourceId, '关系起点', 160),
      targetId: shortString(row.targetId, '关系终点', 160),
      relation: oneOf(row.relation, ['prerequisite', 'evidence', 'analogy', 'support', 'counterexample', 'contains'] as const, '关系类型'),
      importance: integerBetween(row.importance, 1, 10, '关系重要度'),
      documentId: shortString(row.documentId, '关系文档 ID', 160),
      reviewStatus: oneOf(row.reviewStatus, ['unverified', 'learner_supported', 'disputed'] as const, '关系判断'),
      reviewedAt: nullableString(row.reviewedAt, '关系判断时间', 80),
    };
  });
  const savedAnswers = array(manifest.savedAnswers ?? [], '回答', MAX_ANSWERS).map((item, index) => {
    const row = record(item, `回答 ${index + 1}`);
    return {
      id: shortString(row.id, '回答 ID', 160),
      nodeId: shortString(row.nodeId, '回答节点 ID', 160),
      question: shortString(row.question, '回答问题', 4_000),
      body: bodyString(row.body, '回答正文'),
      adapter: oneOf(row.adapter, ['local', 'gateway', 'byok', 'imported'] as const, '回答来源'),
      actualModel: nullableString(row.actualModel, '回答模型', 300),
      createdAt: shortString(row.createdAt, '回答创建时间', 80),
      updatedAt: shortString(row.updatedAt, '回答更新时间', 80),
    };
  });
  const answers = manifest.answers === undefined
    ? savedAnswers.map((answer) => ({ ...answer, saved: true }))
    : array(manifest.answers, '全部回答', MAX_ANSWERS).map((item, index) => {
        const row = record(item, `全部回答 ${index + 1}`);
        return {
          id: shortString(row.id, '回答 ID', 160),
          nodeId: shortString(row.nodeId, '回答节点 ID', 160),
          question: shortString(row.question, '回答问题', 4_000),
          body: bodyString(row.body, '回答正文'),
          adapter: oneOf(row.adapter, ['local', 'gateway', 'byok', 'imported'] as const, '回答来源'),
          actualModel: nullableString(row.actualModel, '回答模型', 300),
          saved: booleanValue(row.saved, '回答收藏状态'),
          createdAt: shortString(row.createdAt, '回答创建时间', 80),
          updatedAt: shortString(row.updatedAt, '回答更新时间', 80),
        };
      });
  const sourceItems = array(manifest.sourceItems ?? [], '资料来源', MAX_SOURCE_ITEMS).map((item, index) => {
    const row = record(item, `资料来源 ${index + 1}`);
    if (row.originalAssetIncluded !== undefined && row.originalAssetIncluded !== false) {
      throw new Error(`资料来源 ${index + 1} 声称包含原始资产，但当前格式不接受内嵌二进制文件`);
    }
    const segments = array(row.segments ?? [], `资料来源 ${index + 1} 片段`, MAX_SOURCE_SEGMENTS)
      .map((segmentValue, segmentIndex) => {
        const segment = record(segmentValue, `资料来源 ${index + 1} 片段 ${segmentIndex + 1}`);
        return {
          ordinal: integerBetween(segment.ordinal, 0, MAX_SOURCE_SEGMENTS, '资料片段顺序'),
          locatorType: oneOf(segment.locatorType, ['text', 'paragraph', 'page', 'image', 'url'] as const, '资料片段定位类型'),
          locator: shortString(segment.locator, '资料片段定位', 500),
          body: bodyString(segment.body, '资料片段正文'),
          contentHash: shortString(segment.contentHash, '资料片段指纹', 160),
        };
      });
    const extractionStatus = row.extractionStatus === undefined
      ? 'ready'
      : oneOf(row.extractionStatus, ['ready', 'processing', 'failed'] as const, '资料提取状态');
    if (extractionStatus === 'ready' && !segments.length) throw new Error(`资料来源 ${index + 1} 没有片段`);
    unique(segments.map((segment) => String(segment.ordinal)), `资料来源 ${index + 1} 片段顺序`);
    return {
      id: shortString(row.id, '资料来源 ID', 160),
      kind: oneOf(row.kind, ['text', 'markdown', 'pdf', 'image', 'web'] as const, '资料来源类型'),
      title: shortString(row.title, '资料来源标题', 300),
      originalName: nullableString(row.originalName, '资料原文件名', 500),
      mediaType: shortString(row.mediaType, '资料媒体类型', 200),
      sourceUrl: nullableString(row.sourceUrl, '资料网址', 4_000),
      contentHash: shortString(row.contentHash, '资料内容指纹', 160),
      byteSize: integerBetween(row.byteSize, 0, 1_000_000_000, '资料字节数'),
      extractionStatus,
      extractionError: nullableString(row.extractionError, '资料提取错误', 1_000),
      originalAssetIncluded: false as const,
      derivedDocumentId: shortString(row.derivedDocumentId, '资料 Markdown ID', 160),
      createdAt: shortString(row.createdAt, '资料创建时间', 80),
      updatedAt: shortString(row.updatedAt, '资料更新时间', 80),
      segments,
    };
  });
  const masteryAttempts = array(manifest.masteryAttempts ?? [], '掌握记录', MAX_MASTERY_ATTEMPTS).map((item, index) => {
    const row = record(item, `掌握记录 ${index + 1}`);
    return {
      id: shortString(row.id, '掌握记录 ID', 160),
      nodeId: shortString(row.nodeId, '掌握记录节点 ID', 160),
      question: shortString(row.question, '掌握问题', 4_000),
      learnerAnswer: bodyString(row.learnerAnswer, '学习者回答'),
      referencePoints: bodyString(row.referencePoints, '掌握参考要点'),
      decision: oneOf(row.decision, ['passed', 'continue_learning'] as const, '掌握决定'),
      createdAt: shortString(row.createdAt, '掌握记录时间', 80),
    };
  });
  const graphMutationBatches = array(manifest.graphMutationBatches ?? [], '图谱修改批次', MAX_GRAPH_BATCHES).map((item, index) => {
    const row = record(item, `图谱修改批次 ${index + 1}`);
    return {
      id: shortString(row.id, '图谱批次 ID', 160),
      selectionId: shortString(row.selectionId, '图谱批次选择节点', 160),
      jobId: shortString(row.jobId, '图谱批次任务 ID', 160),
      answerId: shortString(row.answerId, '图谱批次回答 ID', 160),
      status: oneOf(row.status, ['applied', 'undone'] as const, '图谱批次状态'),
      createdNodeIds: stringArray(row.createdNodeIds, '图谱批次节点', MAX_NODES),
      createdEdgeIds: stringArray(row.createdEdgeIds, '图谱批次关系', MAX_EDGES),
      createdDocumentIds: stringArray(row.createdDocumentIds, '图谱批次文档', MAX_DOCUMENTS),
      committedAt: shortString(row.committedAt, '图谱批次提交时间', 80),
      undoneAt: nullableString(row.undoneAt, '图谱批次撤销时间', 80),
    };
  });
  const sourceCitations = array(manifest.sourceCitations ?? [], '资料引用', MAX_SOURCE_CITATIONS).map((item, index) => {
    const row = record(item, `资料引用 ${index + 1}`);
    return {
      id: shortString(row.id, '资料引用 ID', 160),
      targetType: oneOf(row.targetType, ['node', 'edge', 'answer', 'document'] as const, '资料引用目标类型'),
      targetId: shortString(row.targetId, '资料引用目标 ID', 160),
      sourceItemId: shortString(row.sourceItemId, '资料引用来源 ID', 160),
      locator: shortString(row.locator, '资料引用定位', 500),
      quote: nullableString(row.quote, '资料引用摘录', 4_000) ?? '',
      createdAt: shortString(row.createdAt, '资料引用时间', 80),
    };
  });
  unique(documents.map((item) => item.id), '文档 ID');
  unique(documents.map((item) => item.path), '文档路径');
  unique(nodes.map((item) => item.id), '节点 ID');
  unique(edges.map((item) => item.id), '关系 ID');
  unique(edges.map((item) => `${item.sourceId}\u0000${item.targetId}\u0000${item.relation}`), '关系端点与类型');
  unique(savedAnswers.map((item) => item.id), '回答 ID');
  unique(answers.map((item) => item.id), '全部回答 ID');
  unique(sourceItems.map((item) => item.id), '资料来源 ID');
  unique(masteryAttempts.map((item) => item.id), '掌握记录 ID');
  unique(graphMutationBatches.map((item) => item.id), '图谱批次 ID');
  unique(sourceCitations.map((item) => item.id), '资料引用 ID');
  const documentIds = new Set(documents.map((item) => item.id));
  const nodeIds = new Set(nodes.map((item) => item.id));
  for (const node of nodes) if (!documentIds.has(node.documentId)) throw new Error(`节点 ${node.title} 的 Markdown 不存在`);
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) throw new Error(`关系 ${edge.id} 存在悬空端点`);
    if (!documentIds.has(edge.documentId)) throw new Error(`关系 ${edge.id} 的 Markdown 不存在`);
  }
  for (const answer of answers) if (!nodeIds.has(answer.nodeId)) throw new Error(`回答 ${answer.id} 的节点不存在`);
  for (const source of sourceItems) {
    if (!documentIds.has(source.derivedDocumentId)) throw new Error(`资料 ${source.title} 的 Markdown 不存在`);
  }
  const answerIds = new Set(answers.map((item) => item.id));
  const edgeIds = new Set(edges.map((item) => item.id));
  const sourceItemIds = new Set(sourceItems.map((item) => item.id));
  for (const attempt of masteryAttempts) {
    if (!nodeIds.has(attempt.nodeId)) throw new Error(`掌握记录 ${attempt.id} 的节点不存在`);
  }
  for (const batch of graphMutationBatches) {
    if (!nodeIds.has(batch.selectionId)) throw new Error(`图谱批次 ${batch.id} 的选择节点不存在`);
    if (!answerIds.has(batch.answerId)) throw new Error(`图谱批次 ${batch.id} 的回答不存在`);
    if (batch.status === 'applied') {
      if (batch.createdNodeIds.some((id) => !nodeIds.has(id))) throw new Error(`图谱批次 ${batch.id} 的节点不存在`);
      if (batch.createdEdgeIds.some((id) => !edgeIds.has(id))) throw new Error(`图谱批次 ${batch.id} 的关系不存在`);
      if (batch.createdDocumentIds.some((id) => !documentIds.has(id))) throw new Error(`图谱批次 ${batch.id} 的文档不存在`);
    }
  }
  for (const citation of sourceCitations) {
    if (!sourceItemIds.has(citation.sourceItemId)) throw new Error(`资料引用 ${citation.id} 的来源不存在`);
    const targetExists = citation.targetType === 'node'
      ? nodeIds.has(citation.targetId)
      : citation.targetType === 'edge'
        ? edgeIds.has(citation.targetId)
        : citation.targetType === 'answer'
          ? answerIds.has(citation.targetId)
          : documentIds.has(citation.targetId);
    if (!targetExists) throw new Error(`资料引用 ${citation.id} 的目标不存在`);
  }
  const fusion = manifest.version === 3 || manifest.fusion !== undefined
    ? validatePortableFusion(manifest.fusion, { nodes: nodeIds, documents: documentIds, answers: answerIds, edges: edgeIds }) : undefined;
  if (fusion?.graphKind !== 'free') assertPrerequisiteAcyclic(nodes.map((node) => node.id), edges);
  const total = documents.reduce((sum, item) => sum + item.body.length, 0)
    + savedAnswers.reduce((sum, item) => sum + item.body.length, 0)
    + sourceItems.reduce((sum, item) => (
      sum + item.segments.reduce((segmentSum, segment) => segmentSum + segment.body.length, 0)
    ), 0)
    + masteryAttempts.reduce((sum, item) => sum + item.learnerAnswer.length + item.referencePoints.length, 0)
    + (fusion?.messages.reduce((sum, item) => sum + item.body.length, 0) ?? 0);
  if (total > MAX_MANIFEST_CHARS) throw new Error('图谱 Markdown 总内容超过 24 MB 上限');
  if (!nodes.length && fusion?.graphKind !== 'free') throw new Error('图谱至少需要一个节点');
  return {
    format: PORTABLE_FORMAT,
    version: fusion ? PORTABLE_VERSION : manifest.version as 1 | 2,
    exportedAt: shortString(manifest.exportedAt, '导出时间', 80),
    project: {
      id: shortString(project.id, '项目 ID', 160),
      topicId: nullableString(project.topicId, '专题 ID', 160),
      title: shortString(project.title, '项目标题', 300),
      sourceText: nullableString(project.sourceText, '项目资料', MAX_MARKDOWN_TOTAL_CHARS) ?? '',
      createdAt: shortString(project.createdAt, '项目创建时间', 80),
      updatedAt: shortString(project.updatedAt, '项目更新时间', 80),
      layoutDirection: project.layoutDirection === undefined
        ? 'vertical'
        : oneOf(project.layoutDirection, ['vertical', 'horizontal'] as const, '图谱展开方向'),
      contentPolicy,
    },
    documents,
    nodes,
    edges,
    savedAnswers: answers.filter((answer) => answer.saved).map(({ saved: _saved, ...answer }) => answer),
    answers,
    sourceItems,
    masteryAttempts,
    graphMutationBatches,
    sourceCitations,
    fusion,
  };
}

export type PortableImportMapping = {
  projectId: string;
  documentIds: Map<string, string>;
  nodeIds: Map<string, string>;
  edgeIds: Map<string, string>;
  answerIds: Map<string, string>;
  sourceItemIds: Map<string, string>;
};

export async function importPortableManifest(db: SQLiteDatabase, manifest: PortableGraphManifest) {
  return (await importPortableManifestWithMapping(db, manifest)).projectId;
}

export async function importPortableManifestWithMapping(
  db: SQLiteDatabase,
  manifest: PortableGraphManifest,
): Promise<PortableImportMapping> {
  const checked = validatePortableManifest(manifest);
  const projectId = createId('project');
  const documentIds = new Map(checked.documents.map((document) => [document.id, createId('doc')]));
  const nodeIds = new Map(checked.nodes.map((node) => [node.id, createId('node')]));
  const edgeIds = new Map(checked.edges.map((edge) => [edge.id, createId('edge')]));
  const allAnswers = checked.answers ?? checked.savedAnswers.map((answer) => ({ ...answer, saved: true }));
  const answerIds = new Map(allAnswers.map((answer) => [answer.id, createId('answer')]));
  const sourceItemIds = new Map((checked.sourceItems ?? []).map((source) => [source.id, createId('source')]));
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO projects (
        id, title, source_text, created_at, updated_at, layout_direction,
        mode, explanation_style, detail_level, allow_outside_knowledge
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      checked.project.title,
      checked.project.sourceText,
      now,
      now,
      checked.project.layoutDirection ?? 'vertical',
      checked.project.contentPolicy?.mode ?? 'learning',
      checked.project.contentPolicy?.explanationStyle ?? 'legacy',
      checked.project.contentPolicy?.detailLevel ?? 'detailed',
      checked.project.contentPolicy?.allowOutsideKnowledge === false ? 0 : 1,
    );
    for (const document of checked.documents) {
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        documentIds.get(document.id)!, projectId, document.path, document.title, remapReadingReferences(document.body, checked.project.id, projectId, documentIds), document.origin,
        document.createdAt, document.updatedAt,
      );
    }
    for (const node of checked.nodes) {
      await transaction.runAsync(
        'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        nodeIds.get(node.id)!, projectId, node.title, node.subtitle, node.x, node.y, node.importance, node.status,
        node.order, documentIds.get(node.documentId)!,
      );
    }
    for (const edge of checked.edges) {
      await transaction.runAsync(
        `INSERT INTO edges
          (id, project_id, source_id, target_id, relation, effective_relation, importance, document_id, review_status, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        edgeIds.get(edge.id)!, projectId, nodeIds.get(edge.sourceId)!, nodeIds.get(edge.targetId)!,
        edge.relation === 'contains' ? 'support' : edge.relation,
        edge.relation === 'contains' ? 'contains' : null,
        edge.importance, documentIds.get(edge.documentId)!, edge.reviewStatus, edge.reviewedAt,
      );
    }
    for (const answer of allAnswers) {
      await insertNodeAnswerInTransaction(transaction, {
        id: answerIds.get(answer.id)!,
        projectId,
        nodeId: nodeIds.get(answer.nodeId)!,
        question: answer.question,
        body: answer.body,
        adapter: 'imported',
        actualModel: answer.actualModel,
        saved: answer.saved,
        createdAt: answer.createdAt,
        updatedAt: answer.updatedAt,
      });
    }
    for (const source of checked.sourceItems ?? []) {
      const sourceId = sourceItemIds.get(source.id)!;
      await transaction.runAsync(
        `INSERT INTO source_items (
          id, project_id, kind, title, original_name, media_type, asset_uri, source_url,
          content_hash, byte_size, extraction_status, extraction_error,
          derived_document_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sourceId,
        projectId,
        source.kind,
        source.title,
        source.originalName,
        source.mediaType,
        source.sourceUrl,
        source.contentHash,
        source.byteSize,
        source.extractionStatus ?? 'ready',
        source.extractionError ?? null,
        documentIds.get(source.derivedDocumentId)!,
        source.createdAt,
        source.updatedAt,
      );
      for (const segment of source.segments) {
        await transaction.runAsync(
          `INSERT INTO source_segments (
            id, source_item_id, ordinal, locator_type, locator, body, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          createId('segment'),
          sourceId,
          segment.ordinal,
          segment.locatorType,
          segment.locator,
          segment.body,
          segment.contentHash,
        );
      }
    }
    for (const attempt of checked.masteryAttempts ?? []) {
      await transaction.runAsync(
        `INSERT INTO mastery_attempts (
          id, project_id, node_id, question, learner_answer, reference_points, decision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        createId('mastery'),
        projectId,
        nodeIds.get(attempt.nodeId)!,
        attempt.question,
        attempt.learnerAnswer,
        attempt.referencePoints,
        attempt.decision,
        attempt.createdAt,
      );
    }
    for (const batch of checked.graphMutationBatches ?? []) {
      const createdNodeIds = batch.createdNodeIds.flatMap((id) => nodeIds.get(id) ?? []);
      const createdEdgeIds = batch.createdEdgeIds.flatMap((id) => edgeIds.get(id) ?? []);
      const createdDocumentIds = batch.createdDocumentIds.flatMap((id) => documentIds.get(id) ?? []);
      const objectFingerprints = buildImportedBatchFingerprints(
        checked,
        batch.status,
        batch.createdNodeIds,
        batch.createdEdgeIds,
        documentIds,
        nodeIds,
        edgeIds,
      );
      await transaction.runAsync(
        `INSERT INTO graph_mutation_batches (
          id, project_id, selection_id, job_id, answer_id, status,
          created_node_ids_json, created_edge_ids_json, created_document_ids_json,
          object_fingerprints_json, committed_at, undone_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        createId('batch'),
        projectId,
        nodeIds.get(batch.selectionId)!,
        createId('import-job'),
        answerIds.get(batch.answerId)!,
        batch.status,
        JSON.stringify(createdNodeIds),
        JSON.stringify(createdEdgeIds),
        JSON.stringify(createdDocumentIds),
        JSON.stringify(objectFingerprints),
        batch.committedAt,
        batch.undoneAt,
      );
    }
    for (const citation of checked.sourceCitations ?? []) {
      const targetId = citation.targetType === 'node'
        ? nodeIds.get(citation.targetId)
        : citation.targetType === 'edge'
          ? edgeIds.get(citation.targetId)
          : citation.targetType === 'answer'
            ? answerIds.get(citation.targetId)
            : documentIds.get(citation.targetId);
      const sourceItemId = sourceItemIds.get(citation.sourceItemId);
      if (!targetId || !sourceItemId) continue;
      await transaction.runAsync(
        `INSERT INTO source_citations (
          id, project_id, target_type, target_id, source_item_id, locator, quote, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        createId('citation'),
        projectId,
        citation.targetType,
        targetId,
        sourceItemId,
        citation.locator,
        citation.quote,
        citation.createdAt,
      );
    }
    await importPortableFusion(transaction, checked.fusion, { projectId, sourceProjectId: checked.project.id, documentIds, nodeIds, answerIds, edgeIds }, createId);
  });
  return {
    projectId,
    documentIds,
    nodeIds,
    edgeIds,
    answerIds,
    sourceItemIds,
  };
}

export async function importMarkdownFiles(
  db: SQLiteDatabase,
  folderTitle: string,
  files: ImportedMarkdownFile[],
) {
  if (!files.length) throw new Error('所选文件夹中没有 Markdown 文件');
  if (files.length > MAX_MARKDOWN_FILES) throw new Error(`Markdown 文件不能超过 ${MAX_MARKDOWN_FILES} 个`);
  const normalized = files.map((file) => ({
    relativePath: safeRelativePath(file.relativePath),
    body: bodyString(file.body, file.relativePath),
  }));
  unique(normalized.map((file) => file.relativePath.toLowerCase()), 'Markdown 路径');
  if (normalized.some((file) => file.body.length > MAX_MARKDOWN_FILE_CHARS)) throw new Error('存在超过 1 MB 的 Markdown 文件');
  if (normalized.reduce((sum, file) => sum + file.body.length, 0) > MAX_MARKDOWN_TOTAL_CHARS) {
    throw new Error('Markdown 总内容超过 12 MB 上限');
  }
  const projectId = createId('project');
  const rootNodeId = createId('node');
  const title = folderTitle.trim().slice(0, 200) || '导入的 Markdown';
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, title, source_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      projectId, title, `从本地文件夹导入 ${normalized.length} 份 Markdown；原文完整保留。`, now, now,
    );
    const rootDocumentId = createId('doc');
    await transaction.runAsync(
      'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rootDocumentId, projectId, '导入说明.md', title,
      `# ${title}\n\n本项目从本地文件夹导入，共 ${normalized.length} 份 Markdown。合成根节点仅用于浏览，不替代任何原文。`,
      'learner', now, now,
    );
    await transaction.runAsync(
      'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rootNodeId, projectId, title, `${normalized.length} 份本地 Markdown`, 516, 100, 10, 'essential', 0, rootDocumentId,
    );
    for (const [index, file] of normalized.entries()) {
      const documentId = createId('doc');
      const nodeId = createId('node');
      const fileTitle = markdownTitle(file.relativePath, file.body);
      const column = index % 3;
      const row = Math.floor(index / 3);
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        documentId, projectId, `导入/${file.relativePath}`, fileTitle, file.body, 'source', now, now,
      );
      await transaction.runAsync(
        'INSERT INTO nodes (id, project_id, title, subtitle, x, y, importance, status, sort_order, document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        nodeId, projectId, fileTitle, file.relativePath, 150 + column * 360, 330 + row * 210, 6, 'learning', index + 1, documentId,
      );
      const edgeId = createId('edge');
      const edgeDocumentId = createId('doc-edge');
      await transaction.runAsync(
        'INSERT INTO documents (id, project_id, path, title, body, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        edgeDocumentId, projectId, `关系/${edgeId}.md`, `${title} → ${fileTitle}`,
        `# 导入关系\n\n**类型：** support\n\n这条关系由导入器创建，用于从文件夹根节点进入原始 Markdown：\`${file.relativePath}\`。`,
        'learner', now, now,
      );
      await transaction.runAsync(
        'INSERT INTO edges (id, project_id, source_id, target_id, relation, importance, document_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        edgeId, projectId, rootNodeId, nodeId, 'support', 6, edgeDocumentId,
      );
    }
  });
  return projectId;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式错误`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > max) throw new Error(`${label}超过 ${max} 项上限`);
  return value;
}

function shortString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value;
}

function nullableString(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}无效`);
  return value;
}

function stringArray(value: unknown, label: string, max: number) {
  return array(value, label, max).map((item) => shortString(item, label, 160));
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}无效`);
  return value;
}

function bodyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_MARKDOWN_FILE_CHARS) throw new Error(`${label}为空或超过 1 MB`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error(`${label}无效`);
  return value;
}

function integerBetween(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}无效`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label}无效`);
  return value as T[number];
}

function parseStoredIdList(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('invalid list');
    return parsed as string[];
  } catch {
    throw new Error('本地图谱批次记录损坏，无法创建便携副本');
  }
}

function buildImportedBatchFingerprints(
  manifest: PortableGraphManifest,
  status: GraphMutationBatch['status'],
  originalNodeIds: string[],
  originalEdgeIds: string[],
  documentIds: Map<string, string>,
  nodeIds: Map<string, string>,
  edgeIds: Map<string, string>,
) {
  if (status === 'undone') return { version: 1, nodes: [], edges: [] };
  const documents = new Map(manifest.documents.map((document) => [document.id, document]));
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]));
  const edges = new Map(manifest.edges.map((edge) => [edge.id, edge]));
  return {
    version: 1,
    nodes: originalNodeIds.map((id) => {
      const node = nodes.get(id)!;
      const document = documents.get(node.documentId)!;
      return {
        id: nodeIds.get(id)!,
        title: node.title,
        subtitle: node.subtitle,
        importance: node.importance,
        status: node.status,
        documentId: documentIds.get(node.documentId)!,
        documentTitle: document.title,
        documentBody: document.body,
      };
    }),
    edges: originalEdgeIds.map((id) => {
      const edge = edges.get(id)!;
      const document = documents.get(edge.documentId)!;
      return {
        id: edgeIds.get(id)!,
        sourceId: nodeIds.get(edge.sourceId)!,
        targetId: nodeIds.get(edge.targetId)!,
        relation: edge.relation,
        importance: edge.importance,
        reviewStatus: edge.reviewStatus,
        documentId: documentIds.get(edge.documentId)!,
        documentTitle: document.title,
        documentBody: document.body,
      };
    }),
  };
}

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label}重复`);
}

function assertPrerequisiteAcyclic(
  nodeIds: string[],
  edges: Array<{ sourceId: string; targetId: string; relation: RelationType }>,
) {
  const adjacency = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (edge.relation === 'prerequisite') adjacency.get(edge.sourceId)?.push(edge.targetId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) throw new Error('前置关系存在循环');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) visit(targetId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId);
}

export function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Markdown 路径包含不安全的目录跳转');
  }
  return segments.map((segment) => segment.replace(/[\u0000-\u001f:*?"<>|]/g, '-')).join('/').slice(0, 500);
}

function markdownTitle(path: string, body: string) {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fileName = path.split('/').at(-1)?.replace(/\.md(?:own)?$/i, '') ?? 'Markdown';
  return (heading || fileName).slice(0, 200);
}

export function portableFileName(value: string, fallback: string) {
  const clean = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (clean || fallback).slice(0, 72);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
