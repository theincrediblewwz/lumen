import type { StoredMessage } from './chatStore';

export type CaptureMessage = StoredMessage & { id: string };
type CaptureCandidate = CaptureMessage & { streaming?: boolean };

/** Save complete question/answer turns, regardless of which side was selected.
 * Failed/empty/unfinished replies must never leave a question-only saved node. */
export function completedCaptureTurns(messages: CaptureCandidate[]): CaptureMessage[][] {
  const turns: CaptureMessage[][] = [];
  let current: CaptureMessage[] = [];
  const finish = () => { if (current.some(m => m.role === 'assistant')) turns.push(current); current = []; };
  for (const message of messages) {
    if (message.role === 'user') finish();
    if (!message.streaming && !message.error && message.content.trim()) current.push(message);
  }
  finish(); return turns;
}
export function captureTurnsForSelection(messages: CaptureCandidate[], ids: ReadonlySet<string>): CaptureMessage[] {
  return completedCaptureTurns(messages).filter(turn => turn.some(message => ids.has(message.id))).flat();
}

export function parseConversationLink(href: string, fallback?: { projectId: string; boardId: string }): { projectId: string; boardId: string; conversationId: string; messageIds: string[] } | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'lumen:' || url.hostname !== 'conversation' || url.username || url.password || url.port) return null;
    const conversationId = decodeURIComponent(url.pathname.slice(1));
    const projectId = url.searchParams.get('project') ?? fallback?.projectId ?? '';
    const boardId = url.searchParams.get('board') ?? fallback?.boardId ?? '';
    const messageIds = (url.searchParams.get('messages') ?? '').split(',').filter(Boolean);
    if (![conversationId, projectId, boardId, ...messageIds].every(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id)) || messageIds.length > 2000) return null;
    return { projectId, boardId, conversationId, messageIds };
  } catch { return null; }
}
export function conversationMarkdown(title: string, conversationId: string, messages: CaptureMessage[], parentId?: string, context?:{projectId:string;boardId:string}): string {
  if (!messages.length || messages.some(m => !m.content.trim() || m.error)) throw new Error('请选择已完成的对话内容');
  const source = `lumen://conversation/${encodeURIComponent(conversationId)}?messages=${messages.map(m => encodeURIComponent(m.id)).join(',')}${context?`&project=${encodeURIComponent(context.projectId)}&board=${encodeURIComponent(context.boardId)}`:''}`;
  return `# ${title.replace(/[\r\n]/g, ' ')}\n\n[返回原对话](${source})${parentId ? ` · [[node:${parentId}]]` : ''}\n\n${messages.map(m => `## ${m.role === 'user' ? '提问' : '回答'}\n\n${m.content}`).join('\n\n---\n\n')}\n`;
}

/** Completed messages are immutable. Share the same selected-message identity with Android. */
export function selectionKey(conversationId:string,messages:CaptureMessage[]):string {return `chat:${conversationId}:${messages.map(m=>m.id).join(',')}`;}
export async function captureKey(conversationId: string, messages: CaptureMessage[]): Promise<string> {
  const bytes = new TextEncoder().encode(selectionKey(conversationId,messages));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
