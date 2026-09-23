import type { SQLiteDatabase } from 'expo-sqlite';

import type { NodeAnswer } from '@/types/domain';
import { setAnswerFavorite } from '@/data/personal-context';

export type AnswerWrite = {
  id?: string;
  projectId: string;
  nodeId: string;
  jobId?: string | null;
  question: string;
  body: string;
  adapter: NodeAnswer['adapter'];
  actualModel?: string | null;
  saved?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type NodeAnswerRow = {
  id: string;
  project_id: string;
  node_id: string;
  job_id: string | null;
  question: string;
  body: string;
  adapter: NodeAnswer['adapter'];
  actual_model: string | null;
  is_saved: number;
  created_at: string;
  updated_at: string;
};

export async function listNodeAnswers(db: SQLiteDatabase, nodeId: string): Promise<NodeAnswer[]> {
  const rows = await db.getAllAsync<NodeAnswerRow>(
    'SELECT * FROM node_answers WHERE node_id = ? ORDER BY is_saved DESC, created_at DESC',
    nodeId,
  );
  return rows.map(mapAnswer);
}

export async function getNodeAnswer(db: SQLiteDatabase, id: string): Promise<NodeAnswer | null> {
  const row = await db.getFirstAsync<NodeAnswerRow>('SELECT * FROM node_answers WHERE id = ?', id);
  return row ? mapAnswer(row) : null;
}

export async function setNodeAnswerSaved(db: SQLiteDatabase, id: string, saved: boolean) {
  await setAnswerFavorite(db, id, saved);
}

export async function insertNodeAnswerInTransaction(db: SQLiteDatabase, input: AnswerWrite): Promise<string> {
  const now = new Date().toISOString();
  const id = input.id ?? createId('answer');
  await db.runAsync(
    `INSERT INTO node_answers
      (id, project_id, node_id, job_id, question, body, adapter, actual_model, is_saved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.nodeId,
    input.jobId ?? null,
    input.question.trim(),
    input.body,
    input.adapter,
    input.actualModel ?? null,
    input.saved ? 1 : 0,
    input.createdAt ?? now,
    input.updatedAt ?? now,
  );
  return id;
}

export function buildAnswerMarkdown(input: {
  nodeTitle: string;
  question: string;
  summary: string;
  nodes: { title: string; subtitle: string; body: string }[];
  edges: { source: string; target: string; relation: string; body: string }[];
}) {
  const nodeSections = input.nodes.map((node) =>
    `## ${node.title}\n\n${node.subtitle ? `> ${node.subtitle}\n\n` : ''}${node.body.trim()}`,
  );
  const edgeSections = input.edges.map((edge) =>
    `### ${edge.source} → ${edge.target}\n\n**关系：** ${edge.relation}\n\n${edge.body.trim()}`,
  );
  return [
    `# ${input.nodeTitle} · 回答记录`,
    `## 你的问题\n\n${input.question.trim()}`,
    `## 本次概要\n\n${input.summary.trim()}`,
    ...nodeSections,
    edgeSections.length ? `## 关系说明\n\n${edgeSections.join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function mapAnswer(row: NodeAnswerRow): NodeAnswer {
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    jobId: row.job_id,
    question: row.question,
    body: row.body,
    adapter: row.adapter,
    actualModel: row.actual_model,
    saved: row.is_saved === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
