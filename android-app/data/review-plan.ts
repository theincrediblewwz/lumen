import type { KnowledgeEdge, KnowledgeNode } from '@/types/domain';

export type ReviewRating = 'remembered' | 'fuzzy' | 'forgotten' | 'deferred';
export type ReviewEventClock = { id: string; nodeId: string; rating: ReviewRating; createdAt: string };
export type ReviewDue = { dueAt: string | null; rememberedStreak: number; lastRating: ReviewRating | null };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONCURRENT_WINDOW = 10 * 60 * 1000;
const rememberedIntervals = [DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY] as const;
const ratingPriority: Record<ReviewRating, number> = { forgotten: 0, fuzzy: 1, remembered: 2, deferred: 3 };
type ReviewGraph = { nodes: Array<Pick<KnowledgeNode, 'id'>>; edges: Array<Pick<KnowledgeEdge, 'sourceId' | 'targetId' | 'directed' | 'importance'>> };

/** Replay immutable events so all devices derive the same next due time. */
export function reviewDue(events: ReviewEventClock[]): ReviewDue {
  const ordered = events.map(event => {
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at) || !Object.hasOwn(ratingPriority, event.rating)) throw new Error('复习记录的时间或自评无效');
    return { ...event, at };
  }).sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  let rememberedStreak = 0;
  let dueAt: string | null = null;
  let lastRating: ReviewRating | null = null;
  for (let index = 0; index < ordered.length;) {
    const start = ordered[index].at;
    let end = start;
    let rating = ordered[index].rating;
    index += 1;
    while (index < ordered.length && ordered[index].at - start <= CONCURRENT_WINDOW) {
      end = ordered[index].at;
      if (ratingPriority[ordered[index].rating] < ratingPriority[rating]) rating = ordered[index].rating;
      index += 1;
    }
    if (rating === 'remembered') rememberedStreak = Math.min(rememberedStreak + 1, rememberedIntervals.length);
    else if (rating !== 'deferred') rememberedStreak = 0;
    const interval = rating === 'remembered' ? rememberedIntervals[rememberedStreak - 1]
      : rating === 'forgotten' ? 4 * HOUR : DAY;
    dueAt = new Date(end + interval).toISOString();
    lastRating = rating;
  }
  return { dueAt, rememberedStreak, lastRating };
}

export function branchReviewNodeIds(graph: ReviewGraph, rootNodeId: string): string[] {
  const known = new Set(graph.nodes.map(node => node.id));
  if (!known.has(rootNodeId)) throw new Error('复习起点已不存在');
  const children = new Map<string, Array<{ id: string; importance: number }>>();
  for (const edge of graph.edges) {
    if (edge.directed === false || edge.sourceId === edge.targetId || !known.has(edge.sourceId) || !known.has(edge.targetId)) continue;
    const list = children.get(edge.sourceId) ?? [];
    list.push({ id: edge.targetId, importance: edge.importance });
    children.set(edge.sourceId, list);
  }
  for (const list of children.values()) list.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const queue = [rootNodeId];
  const result: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const child of children.get(id) ?? []) if (!seen.has(child.id)) queue.push(child.id);
  }
  return result;
}

/** Pick a short, stable batch. Explicit early review can include not-yet-due cards. */
export function pickBranchReviewNodes(
  graph: ReviewGraph,
  rootNodeId: string,
  events: ReviewEventClock[],
  now: string,
  includeUpcoming = false,
  limit = 5,
): string[] {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error('设备时间无效');
  const branch = branchReviewNodeIds(graph, rootNodeId);
  const byNode = new Map<string, ReviewEventClock[]>();
  for (const event of events) {
    const list = byNode.get(event.nodeId) ?? [];
    list.push(event);
    byNode.set(event.nodeId, list);
  }
  return branch.map((id, order) => {
    const due = reviewDue(byNode.get(id) ?? []);
    return { id, order, due: due.dueAt ? Date.parse(due.dueAt) : Number.NEGATIVE_INFINITY };
  }).filter(item => includeUpcoming || item.due <= at)
    .sort((left, right) => left.due - right.due || left.order - right.order)
    .slice(0, Math.max(1, Math.min(limit, 5)))
    .map(item => item.id);
}
