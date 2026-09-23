import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CONTENT_V2_MIGRATION_SQL, LOCAL_KNOWLEDGE_MIGRATION_SQL } from '../data/database';
import { buildAnswerMarkdown } from '../data/node-answers';
import {
  parsePortableManifest,
  portableFileName,
  safeRelativePath,
  validatePortableManifest,
} from '../data/portable-knowledge';

const validManifest = {
  format: 'learnstuff-graph',
  version: 1,
  exportedAt: '2026-07-24T00:00:00.000Z',
  project: { id: 'p1', title: '测试图', sourceText: '原始资料', createdAt: 'now', updatedAt: 'now' },
  documents: [
    { id: 'd1', path: '节点/目标.md', title: '目标', body: '# 目标\n\n正文', origin: 'source', createdAt: 'now', updatedAt: 'now' },
    { id: 'd2', path: '节点/基础.md', title: '基础', body: '# 基础\n\n正文', origin: 'ai', createdAt: 'now', updatedAt: 'now' },
    { id: 'de', path: '关系/e1.md', title: '目标到基础', body: '# 关系\n\n说明', origin: 'ai', createdAt: 'now', updatedAt: 'now' },
  ],
  nodes: [
    { id: 'n1', title: '目标', subtitle: '', x: 10, y: 20, importance: 10, status: 'essential', order: 0, documentId: 'd1' },
    { id: 'n2', title: '基础', subtitle: '', x: 10, y: 220, importance: 8, status: 'learning', order: 1, documentId: 'd2' },
  ],
  edges: [
    { id: 'e1', sourceId: 'n1', targetId: 'n2', relation: 'prerequisite', importance: 8, documentId: 'de', reviewStatus: 'unverified', reviewedAt: null },
  ],
  savedAnswers: [
    { id: 'a1', nodeId: 'n1', question: '为什么？', body: '# 回答\n\n因为。', adapter: 'byok', actualModel: 'test-model', createdAt: 'now', updatedAt: 'now' },
  ],
} as const;

test('portable v1 validates a complete document-backed graph and saved answer', () => {
  const parsed = parsePortableManifest(JSON.stringify(validManifest));
  assert.equal(parsed.project.title, '测试图');
  assert.equal(parsed.project.layoutDirection, 'vertical');
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.savedAnswers[0].actualModel, 'test-model');
});

test('portable v1 preserves an optional horizontal reading direction', () => {
  const horizontal = structuredClone(validManifest) as any;
  horizontal.project.layoutDirection = 'horizontal';
  assert.equal(validatePortableManifest(horizontal).project.layoutDirection, 'horizontal');
  horizontal.project.layoutDirection = 'diagonal';
  assert.throws(() => validatePortableManifest(horizontal), /展开方向/);
});

test('portable v2 preserves summary policy, contains edges, sources, mastery, provenance and undo batches', () => {
  const manifest = structuredClone(validManifest) as any;
  manifest.version = 2;
  manifest.project.contentPolicy = {
    version: 1,
    mode: 'summary',
    explanationStyle: 'plain_language',
    detailLevel: 'detailed',
    allowOutsideKnowledge: false,
  };
  manifest.project.topicId = 'topic-1';
  manifest.edges[0].relation = 'contains';
  manifest.answers = manifest.savedAnswers.map((answer: any) => ({ ...answer, saved: true }));
  manifest.sourceItems = [{
    id: 's1',
    kind: 'text',
    title: '原始资料',
    originalName: null,
    mediaType: 'text/plain',
    sourceUrl: null,
    contentHash: 'hash-source',
    byteSize: 12,
    originalAssetIncluded: false,
    derivedDocumentId: 'd1',
    createdAt: 'now',
    updatedAt: 'now',
    segments: [{
      ordinal: 0,
      locatorType: 'paragraph',
      locator: '第 1 段',
      body: '原始资料正文。',
      contentHash: 'hash-segment',
    }],
  }];
  manifest.masteryAttempts = [{
    id: 'm1',
    nodeId: 'n2',
    question: '请解释基础。',
    learnerAnswer: '这是我的回答。',
    referencePoints: '应该覆盖核心概念。',
    decision: 'passed',
    createdAt: 'now',
  }];
  manifest.graphMutationBatches = [{
    id: 'b1',
    selectionId: 'n1',
    jobId: 'j1',
    answerId: 'a1',
    status: 'applied',
    createdNodeIds: ['n2'],
    createdEdgeIds: ['e1'],
    createdDocumentIds: ['d2', 'de'],
    committedAt: 'now',
    undoneAt: null,
  }];
  manifest.sourceCitations = [{
    id: 'c1',
    targetType: 'node',
    targetId: 'n2',
    sourceItemId: 's1',
    locator: '第 1 段',
    quote: '',
    createdAt: 'now',
  }];
  const checked = validatePortableManifest(manifest);
  assert.equal(checked.project.contentPolicy?.mode, 'summary');
  assert.equal(checked.project.topicId, 'topic-1');
  assert.equal(checked.edges[0].relation, 'contains');
  assert.equal(checked.sourceItems?.[0].originalAssetIncluded, false);
  assert.equal(checked.masteryAttempts?.[0].decision, 'passed');
  assert.deepEqual(checked.graphMutationBatches?.[0].createdNodeIds, ['n2']);
  assert.equal(checked.sourceCitations?.[0].locator, '第 1 段');
});

test('portable v2 preserves failed extraction metadata without requiring fake source segments', () => {
  const manifest = structuredClone(validManifest) as any;
  manifest.version = 2;
  manifest.sourceItems = [{
    id: 'failed-source',
    kind: 'pdf',
    title: '扫描资料',
    originalName: 'scan.pdf',
    mediaType: 'application/pdf',
    sourceUrl: null,
    contentHash: 'failed-hash',
    byteSize: 100,
    extractionStatus: 'failed',
    extractionError: '没有识别到文字',
    originalAssetIncluded: false,
    derivedDocumentId: 'd1',
    createdAt: 'now',
    updatedAt: 'now',
    segments: [],
  }];
  const checked = validatePortableManifest(manifest);
  assert.equal(checked.sourceItems?.[0].extractionStatus, 'failed');
  assert.equal(checked.sourceItems?.[0].segments.length, 0);
});

test('portable v1 rejects path traversal and dangling graph references', () => {
  const unsafe = structuredClone(validManifest) as any;
  unsafe.documents[0].path = '../逃逸.md';
  assert.throws(() => validatePortableManifest(unsafe), /不安全/);
  const dangling = structuredClone(validManifest) as any;
  dangling.edges[0].targetId = 'missing';
  assert.throws(() => validatePortableManifest(dangling), /悬空端点/);
  const cycle = structuredClone(validManifest) as any;
  cycle.documents.push({ ...cycle.documents[2], id: 'de2', path: '关系/e2.md' });
  cycle.edges.push({ ...cycle.edges[0], id: 'e2', sourceId: 'n2', targetId: 'n1', documentId: 'de2' });
  assert.throws(() => validatePortableManifest(cycle), /存在循环/);
});

test('portable file names stay flat while relative Markdown paths preserve folders', () => {
  assert.equal(portableFileName('A/B: C?', 'fallback'), 'A-B-C');
  assert.equal(safeRelativePath('课程\\第一章.md'), '课程/第一章.md');
  assert.throws(() => safeRelativePath('课程/../密钥.md'), /不安全/);
});

test('answer snapshot preserves the question, generated Markdown, and relation explanation', () => {
  const body = buildAnswerMarkdown({
    nodeTitle: '目标', question: '为什么？', summary: '概要',
    nodes: [{ title: '基础', subtitle: '起点', body: '# 基础\n\n原文' }],
    edges: [{ source: '目标', target: '基础', relation: 'prerequisite', body: '关系正文' }],
  });
  assert.match(body, /你的问题[\s\S]*为什么/);
  assert.match(body, /# 基础/);
  assert.match(body, /关系正文/);
});

test('v7 migration creates editable templates and saved node answers without weakening foreign keys', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE ai_expansion_jobs (id TEXT PRIMARY KEY NOT NULL);
    ${LOCAL_KNOWLEDGE_MIGRATION_SQL}
    INSERT INTO projects VALUES ('p1');
    INSERT INTO nodes VALUES ('n1', 'p1');
    INSERT INTO prompt_templates VALUES ('t1', '名称', '正文', 0, 'now', 'now');
    INSERT INTO node_answers VALUES ('a1', 'p1', 'n1', NULL, '问题', '回答', 'local', NULL, 1, 'now', 'now');
  `);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  assert.equal((db.prepare('SELECT is_saved FROM node_answers').get() as { is_saved: number }).is_saved, 1);
  assert.equal((db.prepare('SELECT title FROM prompt_templates').get() as { title: string }).title, '名称');
});

test('v12 migration preserves old rows and adds source, mastery, contains and auditable batch storage', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, source_text TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, origin TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, subtitle TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      importance INTEGER NOT NULL, status TEXT NOT NULL, sort_order INTEGER,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL CHECK(relation IN ('prerequisite', 'evidence', 'analogy', 'support', 'counterexample')),
      importance INTEGER NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
      review_status TEXT NOT NULL DEFAULT 'unverified', reviewed_at TEXT
    );
    CREATE TABLE node_answers (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, job_id TEXT,
      question TEXT NOT NULL, body TEXT NOT NULL, adapter TEXT NOT NULL, actual_model TEXT,
      is_saved INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE local_backup_settings (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE local_backup_jobs (
      id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
      requested_at TEXT, last_error TEXT
    );
    INSERT INTO local_backup_settings VALUES (1, 1);
    INSERT INTO local_backup_jobs VALUES (1, 0, 'idle', NULL, NULL);
    INSERT INTO projects VALUES ('p1', '旧项目', '原资料', 'now', 'now');
    INSERT INTO documents VALUES ('d1', 'p1', '目标.md', '目标', '# 目标', 'source', 'now', 'now');
    INSERT INTO nodes VALUES ('n1', 'p1', '目标', '', 0, 0, 10, 'essential', 0, 'd1');
    INSERT INTO node_answers VALUES ('a1', 'p1', 'n1', NULL, '问题', '回答', 'local', NULL, 0, 'now', 'now');
    ${CONTENT_V2_MIGRATION_SQL}
  `);
  const project = db.prepare('SELECT mode, explanation_style, detail_level, allow_outside_knowledge FROM projects').get() as any;
  assert.deepEqual({ ...project }, {
    mode: 'learning',
    explanation_style: 'legacy',
    detail_level: 'detailed',
    allow_outside_knowledge: 1,
  });
  db.exec(`
    INSERT INTO source_items VALUES ('s1', 'p1', 'text', '资料', NULL, 'text/plain', NULL, NULL, 'hash', 4, 'ready', NULL, 'd1', 'now', 'now');
    INSERT INTO source_segments VALUES ('ss1', 's1', 0, 'paragraph', '第 1 段', '正文', 'segment-hash');
    INSERT INTO mastery_attempts VALUES ('m1', 'p1', 'n1', '题目', '回答', '参考', 'passed', 'now');
    INSERT INTO graph_mutation_batches VALUES ('b1', 'p1', 'n1', 'j1', 'a1', 'undone', '[]', '[]', '[]', '{"version":1,"nodes":[],"edges":[]}', 'now', 'now');
  `);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM source_segments').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mastery_attempts').get() as { count: number }).count, 1);
  assert.ok((db.prepare('SELECT revision FROM local_backup_jobs').get() as { revision: number }).revision >= 4);
});
