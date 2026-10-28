/**
 * 上下文 token 预算与历史压缩（M5-4）。
 *
 * 目标：把「system 提示词 + 历史消息 + 本轮问题」控制在预算 token 内，
 * 避免超长请求被服务端拒绝或烧钱。策略（本地优先、无网络、可预测）：
 *   1) 当前问题原串保留，无法容纳时由调用方拒绝发送。
 *   2) system 提示词始终保留（含白板大纲，是回答质量的地基）。
 *   3) 从最新往旧保留消息，直到逼近预算；
 *   4) 被挤出的旧消息以有界原文摘录作为资料附带，
 *      让模型仍知道之前聊过什么，而不是凭空断片。
 */

import { estimateTokens } from './boardContext';
import type { ChatMessage } from './provider';

/** 单条消息最多占多少 token（防止一条超长贴文吃掉整个预算）。 */
export const MAX_MSG_TOKENS = 2000;

/** 预算下限：低于此值会挤不下任何东西，兜底抬到这里。 */
export const MIN_BUDGET = 1000;

export function messageTokens(m: ChatMessage): number {
  return estimateTokens(JSON.stringify(m)) + 1;
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
export function summarizeDropped(dropped: ChatMessage[], maxTokens=800): string {
  const eligible=dropped.filter(m=>m.role==='user'||m.role==='assistant');
  const selected=eligible.length<=12?eligible:[...eligible.slice(0,4),...eligible.slice(-8)];
  const parts = selected
    .map((m) => {
      const who = m.role === 'user' ? '用户' : '助手';
      const oneLine = (m.content || '').slice(0,120).replace(/\s+/g, ' ').trim();
      const clipped = oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
      return `${who}：${clipped}`;
    })
    .filter((s) => s.length > 3);
  if (parts.length === 0) return '';
  return truncateToTokens(`早前对话摘要（仅原文摘录，并非完整语义总结；原记录仍保留，不能据此断言遗漏的事实。共${eligible.length}条）：\n` + parts.join('\n'),maxTokens);
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
  minimum=MIN_BUDGET,
): BudgetResult {
  const cap = Math.max(minimum, Number.isFinite(budget)?Math.floor(budget):minimum);
  const total = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  if (total <= cap) return { messages: messages.slice(), tokens: total, compressed: false, droppedCount: 0 };

  // 分离固定 system 头
  let system: ChatMessage | null = null;
  let rest = messages;
  if (messages.length && messages[0].role === 'system') {
    system = messages[0];
    rest = messages.slice(1);
  }

  const systemTokens = system ? messageTokens(system) : 0;
  // Keep the current question byte-for-byte. If it cannot fit, the caller
  // rejects before sending; a shortened question must never look complete.
  const latest=rest.at(-1);
  if(latest&&systemTokens+messageTokens(latest)>cap){const fixed=[...(system?[system]:[]),latest];return {messages:fixed,tokens:fixed.reduce((sum,m)=>sum+messageTokens(m),0),compressed:rest.length>1,droppedCount:Math.max(0,rest.length-1)};}
  const recapReserve=Math.min(800,Math.floor(cap*.12));
  let remaining = cap - systemTokens - recapReserve;

  // 2) 从最新往旧收集，直到放不下
  const kept: ChatMessage[] = [];
  let i = rest.length - 1;
  for (; i >= 0; i--) {
    const t = messageTokens(rest[i]);
    if (t <= remaining || kept.length === 0) {
      // 至少保留最后一条（本轮问题），哪怕略超也要发，否则无法对话
      kept.push(rest[i]);
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

  const dropped = rest.slice(0, i + 1);
  const out: ChatMessage[] = [];
  if (system) out.push(system);

  const compressed = dropped.length>0;
  if (dropped.length > 0) {
    const allowance=cap-systemTokens-kept.reduce((sum,m)=>sum+messageTokens(m),0);
    const summary = allowance>40?summarizeDropped(dropped,allowance-24):'';
    if (summary) {
      out.push({ role: 'user', content: summary });
    }
  }
  out.push(...kept);

  const tokens = out.reduce((sum, m) => sum + messageTokens(m), 0);
  return { messages: out, tokens, compressed, droppedCount: dropped.length };
}
