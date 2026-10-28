import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateDatabase } from '../data/database';
import { createPortableManifest, importPortableManifestWithMapping } from '../data/portable-knowledge';
import {
  currentReviewSourceChanged, finishBranchReview, getReviewSession, recordBranchReview, revealReviewReference,
  saveReviewDraft, startBranchReview, type ReviewRuntime,
} from '../data/branch-review';

async function fixture() {
  const raw = new DatabaseSync(':memory:');
  const api = {
    execAsync: async (sql: string) => { raw.exec(sql); },
    runAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (work: (tx: SQLiteDatabase) => Promise<void>) => {
      raw.exec('BEGIN IMMEDIATE');
      try { await work(api as unknown as SQLiteDatabase); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const db = api as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  let serial = 0;
  const runtime: ReviewRuntime = {
    now: () => '2026-09-28T08:00:00.000Z',
    uuid: async () => `fixed-${++serial}`,
    digest: async value => `digest:${value.length}`,
  };
  return { raw, db, runtime };
}

test('review session survives reopening, records one rated event atomically and leaves mastery status unchanged', async t => {
  const { raw, db, runtime } = await fixture(); t.after(() => raw.close());
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 19);
  const first = await startBranchReview(db, 'project-transformer', 'node-transformer', false, runtime);
  assert.ok(first);
  assert.ok(first.cards.length >= 1 && first.cards.length <= 5);
  assert.equal(await currentReviewSourceChanged(db, first.cards[0], runtime), false);
  const originalReference = first.cards[0].reference;
  raw.prepare('UPDATE documents SET body=body||? WHERE id=?').run('\n\n新补充的资料', first.cards[0].documentId);
  assert.equal(await currentReviewSourceChanged(db, first.cards[0], runtime), true);
  assert.equal(first.cards[0].reference, originalReference);
  const beforeStatus = (raw.prepare("SELECT status FROM nodes WHERE id='node-transformer'").get() as { status: string }).status;
  await saveReviewDraft(db, first.id, 0, 2, '我自己的回答');
  await saveReviewDraft(db, first.id, 0, 1, '过期写入');
  const resumed = await startBranchReview(db, 'project-transformer', 'node-transformer', false, runtime);
  assert.equal(resumed?.id, first.id);
  assert.equal(resumed?.answerDraft, '我自己的回答');
  assert.equal(await revealReviewReference(db, first.id, 0, '我自己的回答'), true);
  const saved = await recordBranchReview(db, first.id, 0, 'remembered', runtime);
  assert.equal(saved.alreadySaved, false);
  assert.equal(saved.dueAt, '2026-09-29T08:00:00.000Z');
  const duplicate = await recordBranchReview(db, first.id, 0, 'forgotten', runtime);
  assert.equal(duplicate.alreadySaved, true);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM review_events WHERE project_id='project-transformer'").get() as { n: number }).n, 1);
  assert.equal((raw.prepare("SELECT status FROM nodes WHERE id='node-transformer'").get() as { status: string }).status, beforeStatus);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM sync_changes WHERE kind='review_events'").get() as { n: number }).n, 1);
  const manifest = await createPortableManifest(db, 'project-transformer');
  assert.equal(manifest.version, 5);
  assert.equal(manifest.reviewEvents?.[0].rating, 'remembered');
  const copied = await importPortableManifestWithMapping(db, manifest);
  const restored = raw.prepare('SELECT node_id,rating,learner_answer FROM review_events WHERE project_id=?').get(copied.projectId) as { node_id: string; rating: string; learner_answer: string };
  assert.equal(restored.node_id, copied.nodeIds.get('node-transformer'));
  assert.equal(restored.rating, 'remembered');
  assert.equal(restored.learner_answer, '我自己的回答');
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  await finishBranchReview(db, first.id);
  assert.equal(await getReviewSession(db, 'project-transformer', 'node-transformer'), null);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM review_events WHERE project_id='project-transformer'").get() as { n: number }).n, 1);
});

test('failed event insert keeps the answer and position; defer needs no answer', async t => {
  const { raw, db, runtime } = await fixture(); t.after(() => raw.close());
  const session = await startBranchReview(db, 'project-transformer', 'node-transformer', false, runtime);
  assert.ok(session);
  raw.exec("CREATE TRIGGER reject_review BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(recordBranchReview(db, session.id, 0, 'deferred', runtime), /injected/);
  assert.equal((await getReviewSession(db, 'project-transformer', 'node-transformer'))?.position, 0);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n, 0);
  raw.exec('DROP TRIGGER reject_review');
  const deferred = await recordBranchReview(db, session.id, 0, 'deferred', runtime);
  assert.equal(deferred.dueAt, '2026-09-29T08:00:00.000Z');
  assert.equal((raw.prepare('SELECT learner_answer FROM review_events').get() as { learner_answer: string }).learner_answer, '');
});

test('a clock moved backwards cannot date a new local review before observed history', async t => {
  const { raw, db, runtime } = await fixture(); t.after(() => raw.close());
  const leafId = (raw.prepare("SELECT n.id FROM nodes n WHERE n.project_id='project-transformer' AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id=n.id) ORDER BY n.id LIMIT 1").get() as { id: string }).id;
  const first = await startBranchReview(db, 'project-transformer', leafId, false, runtime);
  assert.ok(first);
  await recordBranchReview(db, first.id, 0, 'deferred', runtime);
  await finishBranchReview(db, first.id);
  const second = await startBranchReview(db, 'project-transformer', leafId, true, runtime);
  assert.ok(second);
  await recordBranchReview(db, second.id, 0, 'deferred', runtime);
  const stamps = raw.prepare('SELECT created_at FROM review_events WHERE node_id=? ORDER BY created_at,id').all(leafId) as { created_at: string }[];
  assert.equal(stamps.length, 2);
  assert.equal(Date.parse(stamps[1].created_at) - Date.parse(stamps[0].created_at), 1);
});
