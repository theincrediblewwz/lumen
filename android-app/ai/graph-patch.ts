import type { KnowledgeStatus, ProjectContentPolicy, RelationType } from '@/types/domain';

export const GRAPH_PATCH_VERSION = 1 as const;
export const EXPANSION_CONTEXT_VERSION = 2 as const;
export const LEARNING_EXPANSION_VERSION = 1 as const;
export const MAX_PATCH_NODES = 8;
export const MAX_PATCH_EDGES = 12;

export type ExpansionDocumentDraft = {
  title: string;
  body: string;
};

export type ExpansionNodeDraft = {
  clientId: string;
  title: string;
  subtitle: string;
  importance: number;
  status: Exclude<KnowledgeStatus, 'mastered'>;
  document: ExpansionDocumentDraft;
};

export type ExpansionEdgeDraft = {
  clientId: string;
  sourceRef: 'selection' | string;
  targetRef: string;
  relation: RelationType;
  importance: number;
  document: ExpansionDocumentDraft;
};

export type GraphPatch = {
  version: typeof GRAPH_PATCH_VERSION;
  summary: string;
  nodes: ExpansionNodeDraft[];
  edges: ExpansionEdgeDraft[];
};

export type LearningExpansion = {
  version: typeof LEARNING_EXPANSION_VERSION;
  answerMarkdown: string;
  keyPoints: Array<{
    title: string;
    importance: number;
    importanceReason: string;
  }>;
  patch: GraphPatch;
};

export type ExpansionContext = {
  requestId: string;
  schemaVersion: typeof EXPANSION_CONTEXT_VERSION;
  project: {
    id: string;
    title: string;
    sourceText: string;
    sourceTextTruncated: boolean;
    contentPolicy?: ProjectContentPolicy;
    sourceReferences?: Array<{
      sourceItemId: string;
      title: string;
      locator: string;
    }>;
  };
  selection: {
    kind: 'node';
    id: string;
    title: string;
    subtitle: string;
    importance: number;
    status: KnowledgeStatus;
    document: {
      path: string;
      title: string;
      body: string;
      origin: 'source' | 'ai' | 'learner';
      truncated: boolean;
    };
  };
  nearbyNodes: Array<{
    id: string;
    title: string;
    importance: number;
    status: KnowledgeStatus;
  }>;
  learningPath: Array<{
    id: string;
    title: string;
    importance: number;
    status: KnowledgeStatus;
    viaRelation: RelationType | null;
  }>;
  relatedKnowledge: Array<{
    id: string;
    title: string;
    importance: number;
    status: KnowledgeStatus;
    relation: RelationType;
    direction: 'outgoing' | 'incoming';
    document: {
      title: string;
      body: string;
      origin: 'source' | 'ai' | 'learner';
      truncated: boolean;
    };
  }>;
  recentAnswers: Array<{
    question: string;
    body: string;
    source: 'local' | 'gateway' | 'byok' | 'imported';
    createdAt: string;
    truncated: boolean;
  }>;
  prompt: string;
  promptTruncated: boolean;
  contextManifest: {
    totalCharacters: number;
    sections: Array<{
      key: 'projectSource' | 'selectionDocument' | 'learningPath' | 'relatedKnowledge' | 'recentAnswers' | 'prompt';
      label: string;
      characters: number;
      truncated: boolean;
    }>;
  };
  constraints: {
    maxNodes: number;
    maxEdges: number;
    allowedRelations: RelationType[];
    targetMustBeNewNode: true;
  };
};

export class GraphPatchValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`图谱补丁无效：${issues.join('；')}`);
    this.name = 'GraphPatchValidationError';
  }
}

const statuses = new Set<ExpansionNodeDraft['status']>([
  'essential',
  'learning',
  'uncertain',
  'optional',
]);
const relations = new Set<RelationType>([
  'prerequisite',
  'evidence',
  'analogy',
  'support',
  'counterexample',
  'contains',
]);
const clientIdPattern = /^[a-z][a-z0-9-]{0,47}$/;

export function validateGraphPatch(input: unknown): GraphPatch {
  const issues: string[] = [];
  if (!isRecord(input)) throw new GraphPatchValidationError(['响应必须是 JSON 对象']);

  if (input.version !== GRAPH_PATCH_VERSION) issues.push('version 必须为 1');
  const summary = readString(input.summary, 'summary', 1, 500, issues);
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (!Array.isArray(input.nodes)) issues.push('nodes 必须是数组');
  if (!Array.isArray(input.edges)) issues.push('edges 必须是数组');
  if (rawNodes.length < 1 || rawNodes.length > MAX_PATCH_NODES) {
    issues.push(`nodes 数量必须在 1-${MAX_PATCH_NODES} 之间`);
  }
  if (rawEdges.length < 1 || rawEdges.length > MAX_PATCH_EDGES) {
    issues.push(`edges 数量必须在 1-${MAX_PATCH_EDGES} 之间`);
  }

  const nodes = rawNodes.map((value, index) => parseNode(value, index, issues));
  const edges = rawEdges.map((value, index) => parseEdge(value, index, issues));
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!clientIdPattern.test(node.clientId)) issues.push(`节点 clientId 非法：${node.clientId || '(空)'}`);
    if (nodeIds.has(node.clientId)) issues.push(`节点 clientId 重复：${node.clientId}`);
    nodeIds.add(node.clientId);
  }

  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (!clientIdPattern.test(edge.clientId)) issues.push(`连线 clientId 非法：${edge.clientId || '(空)'}`);
    if (edgeIds.has(edge.clientId)) issues.push(`连线 clientId 重复：${edge.clientId}`);
    edgeIds.add(edge.clientId);
    if (edge.sourceRef !== 'selection' && !nodeIds.has(edge.sourceRef)) {
      issues.push(`连线 ${edge.clientId} 的 sourceRef 不存在：${edge.sourceRef}`);
    }
    if (!nodeIds.has(edge.targetRef)) {
      issues.push(`连线 ${edge.clientId} 的 targetRef 必须是本次新节点：${edge.targetRef}`);
    }
    if (edge.sourceRef === edge.targetRef) issues.push(`连线 ${edge.clientId} 不能连接自身`);
    const edgeKey = `${edge.sourceRef}|${edge.targetRef}|${edge.relation}`;
    if (edgeKeys.has(edgeKey)) issues.push(`存在重复连线：${edgeKey}`);
    edgeKeys.add(edgeKey);
    incoming.add(edge.targetRef);
  }
  for (const nodeId of nodeIds) {
    if (!incoming.has(nodeId)) issues.push(`新节点缺少入边：${nodeId}`);
  }
  detectPrerequisiteCycle(nodes, edges, issues);

  if (issues.length > 0) throw new GraphPatchValidationError(issues);
  return {
    version: GRAPH_PATCH_VERSION,
    summary,
    nodes,
    edges,
  };
}

export function validateLearningExpansion(input: unknown): LearningExpansion {
  const issues: string[] = [];
  if (!isRecord(input)) throw new GraphPatchValidationError(['学习展开结果必须是 JSON 对象']);
  if (input.version !== LEARNING_EXPANSION_VERSION) issues.push('学习展开结果 version 必须为 1');
  const answerMarkdown = readString(input.answerMarkdown, 'answerMarkdown', 120, 30_000, issues);
  const rawKeyPoints = Array.isArray(input.keyPoints) ? input.keyPoints : [];
  if (!Array.isArray(input.keyPoints)) issues.push('keyPoints 必须是数组');
  if (rawKeyPoints.length < 1 || rawKeyPoints.length > MAX_PATCH_NODES) {
    issues.push(`keyPoints 数量必须在 1-${MAX_PATCH_NODES} 之间`);
  }
  const keyPoints = rawKeyPoints.map((value, index) => {
    if (!isRecord(value)) {
      issues.push(`keyPoints[${index}] 必须是对象`);
      return { title: '', importance: 1, importanceReason: '' };
    }
    return {
      title: readString(value.title, `keyPoints[${index}].title`, 1, 120, issues),
      importance: readInteger(value.importance, `keyPoints[${index}].importance`, 1, 10, issues),
      importanceReason: readString(value.importanceReason, `keyPoints[${index}].importanceReason`, 8, 300, issues),
    };
  });
  let patch: GraphPatch;
  try {
    patch = validateGraphPatch(input.patch);
  } catch (error) {
    if (error instanceof GraphPatchValidationError) issues.push(...error.issues.map((issue) => `patch.${issue}`));
    patch = { version: GRAPH_PATCH_VERSION, summary: '', nodes: [], edges: [] };
  }
  if (patch.nodes.length < 1 || patch.nodes.length > MAX_PATCH_NODES) {
    issues.push(`学习展开必须生成 1-${MAX_PATCH_NODES} 个知识节点`);
  }
  if (keyPoints.length !== patch.nodes.length) issues.push('keyPoints 必须与生成节点一一对应');
  const pointByTitle = new Map(keyPoints.map((point) => [point.title, point]));
  if (pointByTitle.size !== keyPoints.length) issues.push('keyPoints.title 不能重复');
  for (const node of patch.nodes) {
    const point = pointByTitle.get(node.title);
    if (!point || point.importance !== node.importance) issues.push(`keyPoints 与节点不一致：${node.title}`);
  }
  if (issues.length > 0) throw new GraphPatchValidationError(issues);
  return { version: LEARNING_EXPANSION_VERSION, answerMarkdown, keyPoints, patch };
}

function parseNode(value: unknown, index: number, issues: string[]): ExpansionNodeDraft {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return emptyNode();
  }
  const status = value.status;
  if (typeof status !== 'string' || !statuses.has(status as ExpansionNodeDraft['status'])) {
    issues.push(`${path}.status 非法`);
  }
  return {
    clientId: readString(value.clientId, `${path}.clientId`, 1, 48, issues),
    title: readString(value.title, `${path}.title`, 1, 120, issues),
    subtitle: readString(value.subtitle, `${path}.subtitle`, 1, 160, issues),
    importance: readInteger(value.importance, `${path}.importance`, 1, 10, issues),
    status: statuses.has(status as ExpansionNodeDraft['status'])
      ? (status as ExpansionNodeDraft['status'])
      : 'learning',
    document: parseDocument(value.document, `${path}.document`, issues),
  };
}

function parseEdge(value: unknown, index: number, issues: string[]): ExpansionEdgeDraft {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return emptyEdge();
  }
  const relation = value.relation;
  if (typeof relation !== 'string' || !relations.has(relation as RelationType)) {
    issues.push(`${path}.relation 非法`);
  }
  return {
    clientId: readString(value.clientId, `${path}.clientId`, 1, 48, issues),
    sourceRef: readString(value.sourceRef, `${path}.sourceRef`, 1, 48, issues),
    targetRef: readString(value.targetRef, `${path}.targetRef`, 1, 48, issues),
    relation: relations.has(relation as RelationType) ? (relation as RelationType) : 'prerequisite',
    importance: readInteger(value.importance, `${path}.importance`, 1, 10, issues),
    document: parseDocument(value.document, `${path}.document`, issues),
  };
}

function parseDocument(value: unknown, path: string, issues: string[]): ExpansionDocumentDraft {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return { title: '', body: '' };
  }
  return {
    title: readString(value.title, `${path}.title`, 1, 160, issues),
    body: readString(value.body, `${path}.body`, 10, 20_000, issues),
  };
}

function detectPrerequisiteCycle(
  nodes: ExpansionNodeDraft[],
  edges: ExpansionEdgeDraft[],
  issues: string[],
) {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.clientId, []);
  for (const edge of edges) {
    if (edge.relation !== 'prerequisite' || edge.sourceRef === 'selection') continue;
    adjacency.get(edge.sourceRef)?.push(edge.targetRef);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (nodes.some((node) => visit(node.clientId))) issues.push('前置关系不能形成环');
}

function readString(value: unknown, path: string, min: number, max: number, issues: string[]) {
  if (typeof value !== 'string') {
    issues.push(`${path} 必须是字符串`);
    return '';
  }
  const clean = value.trim();
  if (clean.length < min || clean.length > max) issues.push(`${path} 长度必须在 ${min}-${max} 之间`);
  return clean;
}

function readInteger(value: unknown, path: string, min: number, max: number, issues: string[]) {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${path} 必须是 ${min}-${max} 的整数`);
    return min;
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyNode(): ExpansionNodeDraft {
  return {
    clientId: '',
    title: '',
    subtitle: '',
    importance: 1,
    status: 'learning',
    document: { title: '', body: '' },
  };
}

function emptyEdge(): ExpansionEdgeDraft {
  return {
    clientId: '',
    sourceRef: '',
    targetRef: '',
    relation: 'prerequisite',
    importance: 1,
    document: { title: '', body: '' },
  };
}

