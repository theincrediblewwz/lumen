import { truncateToTokens } from './budget';
import { requestInputTokens, type ChatMessage } from './provider';
import { WRITE_TOOL } from './tools';

export interface ToolHistory {
  rounds: ChatMessage[][];
  compacted: number;
  receipts: string[];
  reads: string[];
}

function rememberRound(history: ToolHistory, round: ChatMessage[]) {
  history.compacted++;
  const [assistant, ...results] = round;
  assistant.tool_calls?.forEach((call, index) => {
    const output = results[index]?.content;
    if (!output) return;
    const isWrite = call.function.name === WRITE_TOOL.function.name;
    const entries = isWrite ? history.receipts : history.reads;
    const locator = isWrite ? '' : ` ${truncateToTokens(call.function.arguments, 65)}`;
    entries.push(`${call.function.name}${locator}\n${truncateToTokens(output, isWrite ? 320 : 210)}`);
    if (entries.length > (isWrite ? 32 : 12)) entries.shift();
  });
}

/** Keep complete protocol turns together, including any provider reasoning signatures. */
export function packToolHistory(
  base: ChatMessage[], history: ToolHistory, definitions: unknown[] | undefined, budget: number, summaryOnly: boolean,
): ChatMessage[] | null {
  const instruction: ChatMessage = { role: 'user', content: '工具已暂停。请按已收到的工具回执列出已完成的操作和剩余事项。' };
  const baseTokens = requestInputTokens(base, definitions);
  if (baseTokens > budget) return null;
  const tail = summaryOnly && baseTokens + requestInputTokens([instruction]) <= budget ? [instruction] : [];
  const desiredRecap = Math.min(3000, Math.floor((budget - baseTokens) / 3));
  let raw = [...base, ...history.rounds.flat(), ...tail];
  let tokens = requestInputTokens(raw, definitions);
  while (history.rounds.length && (tokens > budget || (history.rounds.length > 1 && history.compacted > 0 && tokens + desiredRecap > budget))) {
    rememberRound(history, history.rounds.shift()!);
    raw = [...base, ...history.rounds.flat(), ...tail];
    tokens = requestInputTokens(raw, definitions);
  }
  if (!history.compacted) return tokens <= budget ? raw : null;

  const allowance = Math.min(desiredRecap, budget - tokens - 16);
  if (allowance < 120) return history.rounds.length ? raw : null;
  const recap = `同一次请求中，较早的 ${history.compacted} 轮工具记录已压缩。以下是回执和读取片段的摘录。继续前请核对已有结果，需要准确细节时按 ID 或偏移重读。\n${[...history.receipts.slice().reverse(), ...history.reads.slice().reverse()].join('\n\n')}`;
  const checkpoint: ChatMessage = { role: 'user', content: truncateToTokens(recap, allowance) };
  const packed = [...base.slice(0, -1), checkpoint, ...base.slice(-1), ...history.rounds.flat(), ...tail];
  return requestInputTokens(packed, definitions) <= budget ? packed : null;
}
