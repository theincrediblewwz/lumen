/**
 * 通用撤销/重做历史栈（M2-8）—— 纯函数、快照式，可在 Node 侧直接单测（DESIGN §8）。
 *
 * 设计：present 为当前权威状态；past/future 为快照序列。
 * - pushState：提交一次原子变更（新建/删除/改标题…），旧 present 入 past，清空 future
 * - replacePresent：只换 present（用于拖拽实时更新，不记历史）
 * - commitFromBaseline：把一次连续交互「开始前的快照」补进 past（用于拖拽结束）
 * - undo/redo：在 past/present/future 间移动；到边界时原样返回
 */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** past 最大深度，超出丢弃最旧的 */
  limit: number;
}

export const DEFAULT_HISTORY_LIMIT = 100;

export function createHistory<T>(present: T, limit: number = DEFAULT_HISTORY_LIMIT): History<T> {
  return { past: [], present, future: [], limit: Math.max(1, limit) };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

/** 裁剪 past 到 limit（保留最近的） */
function capPast<T>(past: T[], limit: number): T[] {
  return past.length > limit ? past.slice(past.length - limit) : past;
}

/** 提交一次原子变更：旧 present 入 past，present=next，清空 future。 */
export function pushState<T>(h: History<T>, next: T): History<T> {
  return {
    ...h,
    past: capPast([...h.past, h.present], h.limit),
    present: next,
    future: [],
  };
}

/** 只替换 present（拖拽实时更新，不记历史、不动 past/future）。 */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}

/**
 * 结束一次连续交互（如拖拽）：把交互「开始前的快照 baseline」补进 past，
 * 保持当前 present，清空 future。present 应已在交互过程中经 replacePresent 更新到最终值。
 */
export function commitFromBaseline<T>(h: History<T>, baseline: T): History<T> {
  return {
    ...h,
    past: capPast([...h.past, baseline], h.limit),
    future: [],
  };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  return {
    ...h,
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const next = h.future[0];
  return {
    ...h,
    past: capPast([...h.past, h.present], h.limit),
    present: next,
    future: h.future.slice(1),
  };
}
