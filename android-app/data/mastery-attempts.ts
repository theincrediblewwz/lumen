import type { SQLiteDatabase } from 'expo-sqlite';

import type { MasteryAttempt } from '@/types/domain';

type MasteryAttemptRow = {
  id: string;
  project_id: string;
  node_id: string;
  question: string;
  learner_answer: string;
  reference_points: string;
  decision: MasteryAttempt['decision'];
  created_at: string;
};

export async function recordMasteryAttempt(
  db: SQLiteDatabase,
  input: {
    nodeId: string;
    question: string;
    learnerAnswer: string;
    referencePoints: string;
    decision: MasteryAttempt['decision'];
  },
) {
  const id = createId('mastery');
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const node = await transaction.getFirstAsync<{ project_id: string }>(
      'SELECT project_id FROM nodes WHERE id = ?',
      input.nodeId,
    );
    if (!node) throw new Error('当前节点不存在');
    await transaction.runAsync(
      `INSERT INTO mastery_attempts (
        id, project_id, node_id, question, learner_answer,
        reference_points, decision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      node.project_id,
      input.nodeId,
      input.question.trim(),
      input.learnerAnswer.trim(),
      input.referencePoints.trim(),
      input.decision,
      now,
    );
    if (input.decision === 'passed') {
      await transaction.runAsync('UPDATE nodes SET status = ? WHERE id = ?', 'mastered', input.nodeId);
    } else {
      await transaction.runAsync(
        `UPDATE nodes SET status = CASE WHEN status = 'mastered' THEN 'learning' ELSE status END WHERE id = ?`,
        input.nodeId,
      );
    }
    await transaction.runAsync(
      'UPDATE projects SET updated_at = ? WHERE id = ?',
      now,
      node.project_id,
    );
  });
  return id;
}

export async function listMasteryAttempts(db: SQLiteDatabase, nodeId: string): Promise<MasteryAttempt[]> {
  const rows = await db.getAllAsync<MasteryAttemptRow>(
    'SELECT * FROM mastery_attempts WHERE node_id = ? ORDER BY created_at DESC, id DESC',
    nodeId,
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    question: row.question,
    learnerAnswer: row.learner_answer,
    referencePoints: row.reference_points,
    decision: row.decision,
    createdAt: row.created_at,
  }));
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
