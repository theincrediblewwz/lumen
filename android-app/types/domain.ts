export type DocumentOrigin = 'source' | 'ai' | 'learner';

export type KnowledgeStatus =
  | 'essential'
  | 'learning'
  | 'mastered'
  | 'uncertain'
  | 'optional';

export type RelationType =
  | 'prerequisite'
  | 'evidence'
  | 'analogy'
  | 'support'
  | 'counterexample'
  | 'contains';

export type EdgeReviewStatus = 'unverified' | 'learner_supported' | 'disputed';
export type LayoutDirection = 'vertical' | 'horizontal';
export type ProjectMode = 'learning' | 'summary';
export type ExplanationStyle = 'legacy' | 'plain_language';
export type DetailLevel = 'one_sentence' | 'concise' | 'detailed' | 'deep';

export type ProjectContentPolicy = {
  version: 1;
  mode: ProjectMode;
  explanationStyle: ExplanationStyle;
  detailLevel: DetailLevel;
  allowOutsideKnowledge: boolean;
};

export type LearningProject = {
  id: string;
  topicId: string | null;
  title: string;
  sourceText: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  masteredCount: number;
  layoutDirection: LayoutDirection;
  contentPolicy: ProjectContentPolicy;
  graphKind?: 'free' | 'learning' | 'summary';
};

export type MarkdownDocument = {
  id: string;
  projectId: string;
  path: string;
  title: string;
  body: string;
  origin: DocumentOrigin;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeNode = {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  importance: number;
  status: KnowledgeStatus;
  order: number | null;
  documentId: string;
};

export type KnowledgeEdge = {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  relation: RelationType;
  importance: number;
  documentId: string;
  reviewStatus: EdgeReviewStatus;
  reviewedAt: string | null;
  relationKind?: string | null;
  directed?: boolean;
  label?: string;
};

export type KnowledgeGraph = {
  project: LearningProject;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
};

export type PromptTemplate = {
  id: string;
  title: string;
  body: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type NodeAnswer = {
  id: string;
  projectId: string;
  nodeId: string;
  jobId: string | null;
  question: string;
  body: string;
  adapter: 'local' | 'gateway' | 'byok' | 'imported';
  actualModel: string | null;
  saved: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Topic = {
  id: string;
  parentId: string | null;
  title: string;
  childTopicCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
};

export type UnderstandingScopeType = 'global' | 'topic' | 'project';
export type UnderstandingCategory = 'preference' | 'known' | 'pending';

export type AiUnderstandingDocument = {
  id: string;
  scopeType: UnderstandingScopeType;
  scopeId: string;
  category: UnderstandingCategory;
  title: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectUnderstandingScope = {
  scopeType: UnderstandingScopeType;
  scopeId: string;
  label: string;
  depth: number;
  enabled: boolean;
  documentCount: number;
};

export type FavoriteTargetType = 'node' | 'answer';

export type FavoriteItem = {
  id: string;
  targetType: FavoriteTargetType;
  targetId: string;
  projectId: string;
  projectTitle: string;
  nodeId: string;
  nodeTitle: string;
  title: string;
  body: string;
  createdAt: string;
  bindings: Array<{
    scopeType: UnderstandingScopeType;
    scopeId: string;
  }>;
};

export type SourceItemKind = 'text' | 'markdown' | 'pdf' | 'image' | 'web';
export type SourceExtractionStatus = 'ready' | 'processing' | 'failed';

export type SourceItem = {
  id: string;
  projectId: string;
  kind: SourceItemKind;
  title: string;
  originalName: string | null;
  mediaType: string;
  assetUri: string | null;
  sourceUrl: string | null;
  contentHash: string;
  byteSize: number;
  extractionStatus: SourceExtractionStatus;
  extractionError: string | null;
  derivedDocumentId: string;
  segmentCount: number;
  extractedCharacters: number;
  createdAt: string;
  updatedAt: string;
};

export type SourceSegment = {
  id: string;
  sourceItemId: string;
  ordinal: number;
  locatorType: 'text' | 'paragraph' | 'page' | 'image' | 'url';
  locator: string;
  body: string;
  contentHash: string;
};

export type SourceCitation = {
  id: string;
  targetType: 'node' | 'edge' | 'answer' | 'document';
  targetId: string;
  sourceItemId: string;
  sourceTitle: string;
  locator: string;
  quote: string;
  createdAt: string;
};

export type MasteryAttempt = {
  id: string;
  projectId: string;
  nodeId: string;
  question: string;
  learnerAnswer: string;
  referencePoints: string;
  decision: 'passed' | 'continue_learning';
  createdAt: string;
};

export type GraphMutationBatch = {
  id: string;
  projectId: string;
  selectionId: string;
  jobId: string;
  answerId: string;
  status: 'applied' | 'undone';
  createdNodeIds: string[];
  createdEdgeIds: string[];
  createdDocumentIds: string[];
  committedAt: string;
  undoneAt: string | null;
};

