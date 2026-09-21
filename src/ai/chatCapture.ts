import type { StoredMessage } from './chatStore';

export type CaptureMessage = StoredMessage & { id: string };
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
