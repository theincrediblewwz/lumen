import assert from 'node:assert/strict';
import test from 'node:test';

import { branchReviewNodeIds, pickBranchReviewNodes, reviewDue, type ReviewEventClock } from '../data/review-plan';

const at = '2026-09-28T08:00:00.000Z';
const event = (id: string, nodeId: string, rating: ReviewEventClock['rating'], createdAt = at): ReviewEventClock => ({ id, nodeId, rating, createdAt });

test('fixed UTC intervals are transparent, cap remembered streak and preserve postponement', () => {
  assert.deepEqual(reviewDue([]), { dueAt: null, rememberedStreak: 0, lastRating: null });
  assert.equal(reviewDue([event('1', 'n', 'remembered')]).dueAt, '2026-09-29T08:00:00.000Z');
  assert.equal(reviewDue([event('1', 'n', 'forgotten')]).dueAt, '2026-09-28T12:00:00.000Z');
  assert.equal(reviewDue([event('1', 'n', 'fuzzy')]).dueAt, '2026-09-29T08:00:00.000Z');
  const first = event('1', 'n', 'remembered');
  const second = event('2', 'n', 'remembered', '2026-09-30T08:00:00.000Z');
  const third = event('3', 'n', 'deferred', '2026-10-01T08:00:00.000Z');
  assert.deepEqual(reviewDue([third, second, first]), {
    dueAt: '2026-10-02T08:00:00.000Z', rememberedStreak: 2, lastRating: 'deferred',
  });
});

test('concurrent ratings keep both source events but schedule conservatively once', () => {
  const one = event('a', 'n', 'remembered');
  const two = event('b', 'n', 'forgotten', '2026-09-28T08:04:00.000Z');
  assert.deepEqual(reviewDue([one, two]), reviewDue([two, one]));
  assert.equal(reviewDue([one, two]).dueAt, '2026-09-28T12:04:00.000Z');
  assert.equal(reviewDue([one, two]).rememberedStreak, 0);
  assert.equal(reviewDue([event('future', 'n', 'remembered', '2026-09-29T08:00:00.000Z')]).dueAt, '2026-09-30T08:00:00.000Z');
  assert.throws(() => reviewDue([event('bad', 'n', 'forgotten', 'not-a-date')]), /时间/);
});

test('branch review traverses directed downstream only, deduplicates multi-parent and cycles, and takes due first', () => {
  const graph = {
    nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })),
    edges: [
      { sourceId: 'a', targetId: 'b', importance: 9, directed: true },
      { sourceId: 'a', targetId: 'c', importance: 5, directed: true },
      { sourceId: 'b', targetId: 'd', importance: 6, directed: true },
      { sourceId: 'c', targetId: 'd', importance: 6, directed: true },
      { sourceId: 'd', targetId: 'a', importance: 2, directed: true },
      { sourceId: 'c', targetId: 'e', importance: 10, directed: false },
    ],
  };
  assert.deepEqual(branchReviewNodeIds(graph, 'a'), ['a', 'b', 'c', 'd']);
  const events = [event('1', 'a', 'remembered'), event('2', 'b', 'forgotten')];
  assert.deepEqual(pickBranchReviewNodes(graph, 'a', events, '2026-09-28T13:00:00.000Z'), ['c', 'd', 'b']);
  assert.deepEqual(pickBranchReviewNodes(graph, 'a', events, '2026-09-28T13:00:00.000Z', true), ['c', 'd', 'b', 'a']);
  assert.throws(() => branchReviewNodeIds(graph, 'missing'), /起点/);
});
