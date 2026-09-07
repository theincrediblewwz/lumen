import { describe, it, expect } from 'vitest';
import {
  truncateToTokens,
  summarizeDropped,
  fitWithinBudget,
  messageTokens,
  MIN_BUDGET,
} from './budget';
import type { ChatMessage } from './provider';

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const sys = (content: string): ChatMessage => ({ role: 'system', content });

describe('truncateToTokens', () => {
  it('短文本原样返回', () => {
    expect(truncateToTokens('hello', 100)).toBe('hello');
  });
  it('超长被截断且带省略标记', () => {
    const long = 'x'.repeat(10000);
    const out = truncateToTokens(long, 50);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('已截断');
  });
  it('预算为 0 返回空串', () => {
    expect(truncateToTokens('abc', 0)).toBe('');
  });
});

describe('summarizeDropped', () => {
  it('拼接用户/助手为摘要', () => {
    const s = summarizeDropped([u('第一个问题'), a('第一个回答')]);
    expect(s).toContain('早前对话摘要');
    expect(s).toContain('用户：第一个问题');
    expect(s).toContain('助手：第一个回答');
  });
  it('空输入返回空串', () => {
    expect(summarizeDropped([])).toBe('');
  });
});

describe('fitWithinBudget', () => {
  it('预算充足时全部保留，不压缩', () => {
    const msgs = [sys('系统提示'), u('你好'), a('你好呀'), u('再问一句')];
    const r = fitWithinBudget(msgs, 8000);
    expect(r.compressed).toBe(false);
    expect(r.messages).toHaveLength(4);
    expect(r.droppedCount).toBe(0);
  });

  it('system 始终保留在队首', () => {
    const msgs = [sys('SYS'), ...Array.from({ length: 40 }, (_, i) => u('问题' + '内容'.repeat(50) + i))];
    const r = fitWithinBudget(msgs, MIN_BUDGET);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[0].content).toBe('SYS');
  });

  it('超预算时压缩最旧历史为摘要并保留最新', () => {
    const big = '内容'.repeat(400); // 约 800 token 一条
    const msgs = [sys('SYS'), u(big + 'A'), a(big + 'B'), u(big + 'C'), u('最新问题')];
    const r = fitWithinBudget(msgs, 1500);
    expect(r.compressed).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    // 最新问题一定在
    expect(r.messages[r.messages.length - 1].content).toBe('最新问题');
    // 队首是 system(原提示)，其后紧跟压缩摘要
    expect(r.messages[0].content).toBe('SYS');
    expect(r.messages.some((m) => m.role === 'system' && m.content.includes('早前对话摘要'))).toBe(true);
  });

  it('至少保留最后一条（哪怕单条超预算）', () => {
    const huge = u('超'.repeat(5000));
    const r = fitWithinBudget([sys('SYS'), huge], 500);
    expect(r.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('预算低于下限时抬到 MIN_BUDGET', () => {
    const msgs = [sys('SYS'), u('a'), u('b')];
    const r = fitWithinBudget(msgs, 10);
    expect(r.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('messageTokens 计入固定开销', () => {
    expect(messageTokens(u('a'))).toBeGreaterThan(1);
  });
});
