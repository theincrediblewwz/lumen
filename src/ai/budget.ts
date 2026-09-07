/**
 * 上下文 token 预算与历史压缩（M5-4）。
 *
 * 目标：把「system 提示词 + 历史消息 + 本轮问题」控制在预算 token 内，
 * 避免超长请求被服务端拒绝或烧钱。策略（本地优先、无网络、可预测）：
 *   1) 单条过长消息先按字符预算硬截断（保留头部，标注省略）。
 *   2) system 提示词始终保留（含白板大纲，是回答质量的地基）。
 *   3) 从最新往旧保留消息，直到逼近预算；
 *   4) 被挤出的最旧若干条，压缩成一条简短的 system「早前对话摘要」塞回队首，
 *      让模型仍知道之前聊过什么，而不是凭空断片。
 */

import { estimateTokens } from './boardContext';
import type { ChatMessage } from './provider';

/** 单条消息最多占多少 token（防止一条超长贴文吃掉整个预算）。 */
export const MAX_MSG_TOKENS = 2000;

/** 预算下限：低于此值会挤不下任何东西，兜底抬到这里。 */
export const MIN_BUDGET = 1000;

export function messageTokens(m: ChatMessage): number {
  // 角色名、分隔符等固定开销粗估 4 token
  return estimateTokens(m.content || '') + 4;
}

/** 按 token 预算硬截断单条文本，保留头部，尾部加省略标记。 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  // estimateTokens 里 CJK≈1token/字、其它≈1token/4字，用二分找最大可保留长度。
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const marker = ' …（内容过长，已截断）';
  const keep = Math.max(0, lo - marker.length);
  return text.slice(0, keep) + marker;
}

/** 把一批被挤出的旧消息压缩成一句摘要文本（不调用模型，纯本地拼接）。 */
export function summarizeDropped(dropped: ChatMessage[]): string {
  const parts = dropped
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const who = m.role === 'user' ? '用户' : '助手';
      const oneLine = (m.content || '').replace(/\s+/g, ' ').trim();
      const clipped = oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
      return `${who}：${clipped}`;
    })
    .filter((s) => s.length > 3);
  if (parts.length === 0) return '';
  return '早前对话摘要（已压缩，供你保持连贯）：\n' + parts.join('\n');
}

export interface BudgetResult {
  messages: ChatMessage[];
  /** 估算的总 token */
  tokens: number;
  /** 是否发生了压缩/丢弃 */
  compressed: boolean;
  /** 被压缩掉的原始消息条数 */
  droppedCount: number;
}

/**
 * 在预算内裁剪对话。约定：
 *   - messages[0] 若为 system 则视为始终保留的系统提示词；
 *   - 其余按时间顺序（旧→新）排列，最后一条通常是本轮 user 问题。
 * 返回可安全发送的消息数组。
 */
export function fitWithinBudget(
  messages: ChatMessage[],
  budget: number,
): BudgetResult {
  const cap = Math.max(MIN_BUDGET, budget);

  // 分离固定 system 头
  let system: ChatMessage | null = null;
  let rest = messages;
  if (messages.length && messages[0].role === 'system') {
    system = messages[0];
    rest = messages.slice(1);
  }

  // 1) 单条硬截断
  const clipped = rest.map((m) =>
    messageTokens(m) > MAX_MSG_TOKENS
      ? { ...m, content: truncateToTokens(m.content, MAX_MSG_TOKENS) }
      : m,
  );

  const systemTokens = system ? messageTokens(system) : 0;
  let remaining = cap - systemTokens;

  // 2) 从最新往旧收集，直到放不下
  const kept: ChatMessage[] = [];
  let i = clipped.length - 1;
  for (; i >= 0; i--) {
    const t = messageTokens(clipped[i]);
    if (t <= remaining || kept.length === 0) {
      // 至少保留最后一条（本轮问题），哪怕略超也要发，否则无法对话
      kept.push(clipped[i]);
      remaining -= t;
      if (remaining <= 0) {
        i--;
        break;
      }
    } else {
      break;
    }
  }
  kept.reverse();

  const dropped = clipped.slice(0, i + 1);
  const out: ChatMessage[] = [];
  if (system) out.push(system);

  let compressed = false;
  if (dropped.length > 0) {
    const summary = summarizeDropped(dropped);
    if (summary) {
      out.push({ role: 'system', content: summary });
      compressed = true;
    }
  }
  out.push(...kept);

  const tokens = out.reduce((sum, m) => sum + messageTokens(m), 0);
  return { messages: out, tokens, compressed, droppedCount: dropped.length };
}
