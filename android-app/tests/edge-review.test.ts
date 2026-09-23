import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BYOK_JOB_MIGRATION_SQL,
  DEEP_BUILD_MIGRATION_SQL,
  EDGE_REVIEW_MIGRATION_SQL,
} from '../data/database';
import { updateEdgeReviewStatus } from '../data/knowledge-repository';

test('v5 migration adds a bounded non-null edge review state without rewriting content', () => {
  assert.match(EDGE_REVIEW_MIGRATION_SQL, /ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unverified'/);
  assert.match(EDGE_REVIEW_MIGRATION_SQL, /'learner_supported'/);
  assert.match(EDGE_REVIEW_MIGRATION_SQL, /'disputed'/);
  assert.match(EDGE_REVIEW_MIGRATION_SQL, /ADD COLUMN reviewed_at TEXT/);
  assert.doesNotMatch(EDGE_REVIEW_MIGRATION_SQL, /\b(DELETE|DROP|UPDATE)\b/i);
});

test('v10 migration adds a quick-compatible quality path and persisted deep stages', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ai_expansion_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      selection_id TEXT NOT NULL,
      quality_marker TEXT
    );
    INSERT INTO ai_expansion_jobs (id, project_id, selection_id)
    VALUES ('old-job', 'project-1', 'node-1');
  `);
  db.exec(DEEP_BUILD_MIGRATION_SQL);
  const oldJob = db.prepare('SELECT quality_path FROM ai_expansion_jobs WHERE id = ?').get('old-job') as {
    quality_path: string;
  };
  assert.equal(oldJob.quality_path, 'quick');
  db.prepare(`INSERT INTO ai_deep_build_stages
    (job_id, stage, stage_order, status, updated_at)
    VALUES (?, 'knowledge_dossier', 1, 'pending', 'now')`).run('old-job');
  const stage = db.prepare('SELECT stage, status FROM ai_deep_build_stages').get() as {
    stage: string;
    status: string;
  };
  assert.equal(stage.stage, 'knowledge_dossier');
  assert.equal(stage.status, 'pending');
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
  db.close();
});

test('v6 migration adds BYOK without weakening active-job uniqueness', () => {
  assert.match(BYOK_JOB_MIGRATION_SQL, /adapter IN \('local', 'gateway', 'byok'\)/);
  assert.match(BYOK_JOB_MIGRATION_SQL, /INSERT INTO ai_expansion_jobs/);
  assert.match(BYOK_JOB_MIGRATION_SQL, /WHERE status IN \('queued', 'running', 'retry_wait'\)/);
  assert.match(BYOK_JOB_MIGRATION_SQL, /PRAGMA user_version = 6/);
});

test('v6 migration preserves existing jobs and accepts a BYOK job in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO projects (id) VALUES ('project-1');
    CREATE TABLE ai_expansion_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selection_type TEXT NOT NULL CHECK(selection_type IN ('node')),
      selection_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      adapter TEXT NOT NULL CHECK(adapter IN ('local', 'gateway')),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      request_json TEXT NOT NULL,
      response_json TEXT,
      error_code TEXT,
      error_message TEXT,
      next_retry_at TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_ai_jobs_project ON ai_expansion_jobs(project_id, created_at DESC);
    CREATE INDEX idx_ai_jobs_recovery ON ai_expansion_jobs(status, lease_expires_at, next_retry_at);
    CREATE UNIQUE INDEX idx_ai_jobs_active_selection ON ai_expansion_jobs(project_id, selection_id)
      WHERE status IN ('queued', 'running', 'retry_wait');
    INSERT INTO ai_expansion_jobs
      (id, project_id, selection_type, selection_id, prompt, adapter, status, request_json, created_at, updated_at)
    VALUES ('old-job', 'project-1', 'node', 'node-1', '', 'local', 'succeeded', '{}', 'now', 'now');
  `);
  db.exec(BYOK_JOB_MIGRATION_SQL);
  db.prepare(`INSERT INTO ai_expansion_jobs
    (id, project_id, selection_type, selection_id, prompt, adapter, status, request_json, created_at, updated_at)
    VALUES (?, ?, 'node', ?, '', 'byok', 'queued', '{}', 'now', 'now')`)
    .run('byok-job', 'project-1', 'node-2');
  const rows = db.prepare('SELECT id, adapter FROM ai_expansion_jobs ORDER BY id').all()
    .map((row) => ({ id: row.id, adapter: row.adapter }));
  assert.deepEqual(rows, [
    { id: 'byok-job', adapter: 'byok' },
    { id: 'old-job', adapter: 'local' },
  ]);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
  db.close();
});

test('edge review update is atomic and clearing review removes its timestamp', async () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const transaction = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      statements.push({ sql, params });
      return { changes: 1 };
    },
  };
  const db = {
    withExclusiveTransactionAsync: async (task: (value: typeof transaction) => Promise<void>) => task(transaction),
  };

  const result = await updateEdgeReviewStatus(db as never, 'edge-1', 'unverified');

  assert.deepEqual(result, { reviewStatus: 'unverified', reviewedAt: null });
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0]?.params, ['unverified', null, 'edge-1']);
  assert.match(statements[1]?.sql ?? '', /UPDATE projects SET updated_at/);
});

test('learner support records a timestamp but does not rename the state as verified', async () => {
  const db = {
    withExclusiveTransactionAsync: async (task: (transaction: { runAsync: () => Promise<{ changes: number }> }) => Promise<void>) =>
      task({ runAsync: async () => ({ changes: 1 }) }),
  };

  const result = await updateEdgeReviewStatus(db as never, 'edge-1', 'learner_supported');

  assert.equal(result.reviewStatus, 'learner_supported');
  assert.ok(result.reviewedAt);
});
