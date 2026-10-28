import type { SQLiteDatabase } from 'expo-sqlite';

import { buildMasteryPrompt } from '@/data/mastery-check';
import { getDocument, getGraph } from '@/data/knowledge-repository';
import { pickBranchReviewNodes, reviewDue, type ReviewEventClock, type ReviewRating } from '@/data/review-plan';

export type ReviewCard = {
  nodeId: string; nodeTitle: string; documentId: string; documentHash: string;
  question: string; reference: string;
};
export type ReviewSession = {
  id: string; projectId: string; rootNodeId: string; cards: ReviewCard[];
  position: number; answerDraft: string; draftRevision: number; revealed: boolean;
};

type SessionRow = {
  id: string; project_id: string; root_node_id: string; cards_json: string;
  position: number; answer_draft: string; draft_revision: number; revealed: number;
};
type EventRow = { id: string; node_id: string; rating: ReviewRating; created_at: string };
export type ReviewRuntime = { now(): string; uuid(): Promise<string>; digest(value: string): Promise<string> };
const defaultRuntime: ReviewRuntime = {
  now: () => new Date().toISOString(),
  uuid: async () => (await import('expo-crypto')).randomUUID(),
  digest: async value => {
    const Crypto = await import('expo-crypto');
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  },
};

function mapSession(row: SessionRow): ReviewSession {
  const cards = JSON.parse(row.cards_json) as ReviewCard[];
  if (!Array.isArray(cards) || !Number.isSafeInteger(row.position) || row.position < 0 || row.position > cards.length) throw new Error('复习进度已损坏');
  return {
    id: row.id, projectId: row.project_id, rootNodeId: row.root_node_id,
    cards, position: row.position, answerDraft: row.answer_draft,
    draftRevision: row.draft_revision, revealed: row.revealed === 1,
  };
}

export async function getReviewSession(db: SQLiteDatabase, projectId: string, rootNodeId: string): Promise<ReviewSession | null> {
  const row = await db.getFirstAsync<SessionRow>(
    'SELECT * FROM local_review_sessions WHERE project_id=? AND root_node_id=?', projectId, rootNodeId,
  );
  return row ? mapSession(row) : null;
}

export async function startBranchReview(db: SQLiteDatabase, projectId: string, rootNodeId: string, includeUpcoming = false, runtime = defaultRuntime): Promise<ReviewSession | null> {
  const existing = await getReviewSession(db, projectId, rootNodeId);
  if (existing) return existing;
  const graph = await getGraph(db, projectId);
  if (!graph) throw new Error('白板不存在');
  const root = graph.nodes.find(node => node.id === rootNodeId);
  if (!root) throw new Error('复习起点已不存在');
  const events = await db.getAllAsync<EventRow>('SELECT id,node_id,rating,created_at FROM review_events WHERE project_id=?', projectId);
  const ids = pickBranchReviewNodes(graph, rootNodeId, events.map(event => ({ id: event.id, nodeId: event.node_id, rating: event.rating, createdAt: event.created_at })), runtime.now(), includeUpcoming);
  if (!ids.length) return null;
  const cards: ReviewCard[] = [];
  for (const id of ids) {
    const node = graph.nodes.find(item => item.id === id)!;
    const document = await getDocument(db, node.documentId);
    if (!document || document.projectId !== projectId) continue;
    const prompt = buildMasteryPrompt(node.title, document.body);
    cards.push({
      nodeId: id, nodeTitle: node.title, documentId: document.id,
      documentHash: await runtime.digest(document.body),
      question: prompt.question, reference: prompt.reference,
    });
  }
  if (!cards.length) throw new Error('这一支的节点文档已不存在');
  const id = `review-session-${await runtime.uuid()}`;
  const now = runtime.now();
  await db.withExclusiveTransactionAsync(async tx => {
    if (!await tx.getFirstAsync('SELECT 1 FROM nodes WHERE id=? AND project_id=?', rootNodeId, projectId)) throw new Error('复习起点已不存在');
    await tx.runAsync(
      `INSERT OR IGNORE INTO local_review_sessions(id,project_id,root_node_id,cards_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?)`, id, projectId, rootNodeId, JSON.stringify(cards), now, now,
    );
  });
  return getReviewSession(db, projectId, rootNodeId);
}

export async function saveReviewDraft(db: SQLiteDatabase, sessionId: string, position: number, draftRevision: number, answer: string) {
  if (answer.length > 20_000) throw new Error('单次回答不能超过 2 万字');
  await db.runAsync(
    `UPDATE local_review_sessions SET answer_draft=?,draft_revision=?,updated_at=?
     WHERE id=? AND position=? AND draft_revision<? AND revealed=0`,
    answer, draftRevision, new Date().toISOString(), sessionId, position, draftRevision,
  );
}

export async function revealReviewReference(db: SQLiteDatabase, sessionId: string, position: number, answer: string): Promise<boolean> {
  if (!answer.trim() || answer.length > 20_000) throw new Error('请先用自己的话回答');
  const result = await db.runAsync(
    `UPDATE local_review_sessions SET answer_draft=?,revealed=1,updated_at=? WHERE id=? AND position=?`,
    answer.trim(), new Date().toISOString(), sessionId, position,
  );
  return result.changes === 1;
}

export async function currentReviewSourceChanged(db: SQLiteDatabase, card: ReviewCard, runtime = defaultRuntime): Promise<boolean> {
  const document = await getDocument(db, card.documentId);
  if (!document) return true;
  const digest = await runtime.digest(document.body);
  return digest !== card.documentHash;
}

export async function recordBranchReview(
  db: SQLiteDatabase,
  sessionId: string,
  expectedPosition: number,
  rating: ReviewRating,
  runtime = defaultRuntime,
): Promise<{ dueAt: string; position: number; completed: boolean; alreadySaved: boolean }> {
  if (!['remembered', 'fuzzy', 'forgotten', 'deferred'].includes(rating)) throw new Error('复习自评无效');
  let outcome: { dueAt: string; position: number; completed: boolean; alreadySaved: boolean } | null = null;
  await db.withExclusiveTransactionAsync(async tx => {
    const row = await tx.getFirstAsync<SessionRow>('SELECT * FROM local_review_sessions WHERE id=?', sessionId);
    if (!row) throw new Error('复习会话已结束');
    const session = mapSession(row);
    const card = session.cards[expectedPosition];
    if (!card) throw new Error('复习题目已变化');
    if (session.position !== expectedPosition) {
      const saved = await tx.getFirstAsync<{ due_at: string }>('SELECT due_at FROM review_events WHERE session_id=? AND node_id=?', sessionId, card.nodeId);
      if (!saved) throw new Error('复习进度已变化，请重新打开');
      outcome = { dueAt: saved.due_at, position: session.position, completed: session.position >= session.cards.length, alreadySaved: true };
      return;
    }
    if (rating !== 'deferred' && (!session.revealed || !session.answerDraft.trim())) throw new Error('请先回答并查看参考');
    if (!await tx.getFirstAsync('SELECT 1 FROM nodes WHERE id=? AND project_id=?', card.nodeId, session.projectId)) throw new Error('节点已删除，无法记录这次复习');
    const previous = await tx.getAllAsync<EventRow>('SELECT id,node_id,rating,created_at FROM review_events WHERE node_id=?', card.nodeId);
    const clockNow = Date.parse(runtime.now());
    if (!Number.isFinite(clockNow)) throw new Error('设备时间无效');
    const latest = previous.reduce((value, event) => Math.max(value, Date.parse(event.created_at)), Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(latest) && previous.length) throw new Error('历史复习时间无效');
    const now = new Date(Math.max(clockNow, latest + 1)).toISOString();
    const id = `review-${await runtime.uuid()}`;
    const clock: ReviewEventClock = { id, nodeId: card.nodeId, rating, createdAt: now };
    const dueAt = reviewDue([...previous.map(item => ({ id: item.id, nodeId: item.node_id, rating: item.rating, createdAt: item.created_at })), clock]).dueAt!;
    await tx.runAsync(
      `INSERT INTO review_events(id,project_id,node_id,document_id,document_hash,session_id,question,learner_answer,reference_points,rating,created_at,due_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, session.projectId, card.nodeId, card.documentId, card.documentHash, sessionId,
      card.question, rating === 'deferred' ? '' : session.answerDraft.trim(), card.reference,
      rating, now, dueAt,
    );
    const position = expectedPosition + 1;
    await tx.runAsync(
      'UPDATE local_review_sessions SET position=?,answer_draft=?,draft_revision=0,revealed=0,updated_at=? WHERE id=?',
      position, '', now, sessionId,
    );
    outcome = { dueAt, position, completed: position >= session.cards.length, alreadySaved: false };
  });
  return outcome!;
}

export async function finishBranchReview(db: SQLiteDatabase, sessionId: string) {
  await db.runAsync('DELETE FROM local_review_sessions WHERE id=?', sessionId);
}
