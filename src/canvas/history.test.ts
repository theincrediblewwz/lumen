import { describe, it, expect } from 'vitest';
import {
  createHistory,
  pushState,
  replacePresent,
  commitFromBaseline,
  undo,
  redo,
  canUndo,
  canRedo,
} from './history';

describe('createHistory', () => {
  it('初始只有 present，不能撤销/重做', () => {
    const h = createHistory(0);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
  it('limit 至少为 1', () => {
    expect(createHistory(0, 0).limit).toBe(1);
    expect(createHistory(0, -5).limit).toBe(1);
  });
});

describe('pushState / undo / redo', () => {
  it('push 后可撤销，撤销回到旧值', () => {
    let h = createHistory(1);
    h = pushState(h, 2);
    h = pushState(h, 3);
    expect(h.present).toBe(3);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(canUndo(h)).toBe(false);
  });
  it('撤销后可重做', () => {
    let h = createHistory('a');
    h = pushState(h, 'b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe('b');
    expect(canRedo(h)).toBe(false);
  });
  it('push 会清空 future（撤销后再改写会切断重做链）', () => {
    let h = createHistory(1);
    h = pushState(h, 2);
    h = pushState(h, 3);
    h = undo(h); // present=2, future=[3]
    expect(canRedo(h)).toBe(true);
    h = pushState(h, 9); // 切断
    expect(h.present).toBe(9);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(h.present).toBe(2);
  });
  it('边界：空栈 undo/redo 原样返回', () => {
    const h = createHistory(5);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});

describe('replacePresent', () => {
  it('只换 present，不产生历史', () => {
    let h = createHistory(1);
    h = replacePresent(h, 2);
    h = replacePresent(h, 3);
    expect(h.present).toBe(3);
    expect(canUndo(h)).toBe(false);
  });
});

describe('commitFromBaseline（模拟拖拽结束）', () => {
  it('把交互开始前的快照补进 past，present 保持最终值', () => {
    let h = createHistory({ x: 0 });
    const baseline = h.present;
    // 拖拽过程中实时更新 present（不记历史）
    h = replacePresent(h, { x: 5 });
    h = replacePresent(h, { x: 10 });
    // 松手：提交
    h = commitFromBaseline(h, baseline);
    expect(h.present).toEqual({ x: 10 });
    expect(canUndo(h)).toBe(true);
    // 撤销应回到拖拽开始前
    h = undo(h);
    expect(h.present).toEqual({ x: 0 });
    // 重做回到 10
    h = redo(h);
    expect(h.present).toEqual({ x: 10 });
  });
});

describe('limit 深度裁剪', () => {
  it('超出 limit 丢弃最旧快照', () => {
    let h = createHistory(0, 3);
    for (let i = 1; i <= 5; i++) h = pushState(h, i);
    expect(h.present).toBe(5);
    expect(h.past.length).toBe(3); // 只保留最近 3 个
    // 连撤 3 次到达最旧保留值 2，无法再撤
    h = undo(h); // 4
    h = undo(h); // 3
    h = undo(h); // 2
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(false);
  });
});
