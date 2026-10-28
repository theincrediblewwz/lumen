export const SHARE_TEXT_LIMIT = 32 * 1024 * 1024;
export type ImportedMessage = { role: 'user' | 'assistant'; content: string; id?: string };
export type ConversationRound = { number: number; messages: ImportedMessage[] };

export function conversationRounds(messages: ImportedMessage[]): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  for (const message of messages) {
    if (message.role === 'user' || !rounds.length) rounds.push({ number: rounds.length + 1, messages: [] });
    rounds[rounds.length - 1].messages.push(message);
  }
  return rounds;
}
export function roundsMarkdown(title: string, rounds: ConversationRound[]): string {
  return `# ${title.replace(/[\r\n]/g, ' ').slice(0, 200)}\n\n` + rounds.map(round =>
    `## 第 ${round.number} 轮\n\n` + round.messages.map(message => `### ${message.role === 'user' ? '提问' : '回答'}\n\n${message.content}`).join('\n\n'),
  ).join('\n\n---\n\n');
}
export function sharedMarkdown(title: string, messages: ImportedMessage[]): string {
  if (!messages.length || !messages.some(message => message.role === 'assistant') || messages.some(message =>
    !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim())) throw Error('页面未返回可导入的问答正文');
  const text = roundsMarkdown(title, conversationRounds(messages));
  if (new TextEncoder().encode(text).length > SHARE_TEXT_LIMIT) throw Error('公开问答超过32MiB读取预算，未截断内容；请分批导入原文。');
  return text;
}
/** Explicit role headings only; headings inside code fences are ordinary content. */
export function markdownTranscript(text: string): ImportedMessage[] | undefined {
  const messages: ImportedMessage[] = [];
  let role: ImportedMessage['role'] | undefined, lines: string[] = [], fence = '', fenceSize = 0;
  let substantivePreamble = false;
  const flush = () => { const content = lines.join('\n').trim(); if (role && content) messages.push({ role, content }); lines = []; role = undefined; };
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const code = line.match(/^\s*(`{3,}|~{3,})/);
    if (code) { if (!fence) { fence = code[1][0]; fenceSize = code[1].length; } else if (code[1][0] === fence && code[1].length >= fenceSize && line.slice(line.indexOf(code[1]) + code[1].length).trim() === '') fence = ''; if (role) lines.push(line); continue; }
    if (!fence) {
      const header = line.match(/^#{1,6}\s+(提问|问题|用户|你|User|Question|回答|助手|AI|ChatGPT|Assistant|Answer)\s*[:：]?\s*$/i);
      if (header) { flush(); role = /^(提问|问题|用户|你|User|Question)$/i.test(header[1]) ? 'user' : 'assistant'; continue; }
      if (/^##\s+第\s*\d+\s*轮\s*$/.test(line)) { while(lines.length && !lines.at(-1)?.trim())lines.pop();if (lines.at(-1)?.trim() === '---') lines.pop(); flush(); continue; }
    }
    if (role) lines.push(line);
    else if (line.trim() && !/^#{1,2}\s|^---$/.test(line)) substantivePreamble = true;
  }
  flush();
  return !substantivePreamble && messages.some(message => message.role === 'user') && messages.some(message => message.role === 'assistant') ? messages : undefined;
}

/** Access only the fields needed from the inert devalue pool. Never execute page scripts or recursively decode a message graph. */
export function extractGptShare(html: string): { title: string; messages: ImportedMessage[]; complete: boolean } {
  let best: ReturnType<typeof extractGptShare> | undefined;
  for (const match of html.matchAll(/streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g)) {
    let pool: unknown[];
    try { const value = JSON.parse(JSON.parse(match[1])); if (!Array.isArray(value) || value.length > 2_000_000) continue; pool = value; } catch { continue; }
    const value = (pointer: unknown): unknown => typeof pointer === 'number' ? (Number.isInteger(pointer) && pointer >= 0 && pointer < pool.length ? pool[pointer] : undefined) : pointer;
    const object = (raw: unknown): Record<string, unknown> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.create(null);
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, pointer] of Object.entries(raw)) {
        const name = /^_\d+$/.test(key) ? pool[Number(key.slice(1))] : key;
        if (typeof name !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        result[name] = value(pointer);
      }
      return result;
    };
    for (const candidate of pool) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const root = object(candidate); if (!Array.isArray(root.linear_conversation)) continue;
      const mapping = object(root.mapping);
      let rows: unknown[] = root.linear_conversation.map(value), complete = Object.keys(mapping).length === rows.length && rows.length > 0;
      if (typeof root.current_node === 'string' && mapping[root.current_node]) {
        const chain: unknown[] = [], seen = new Set<string>(); let next: unknown = root.current_node;
        while (typeof next === 'string' && !seen.has(next) && mapping[next]) {
          seen.add(next); const row = object(mapping[next]); chain.push(mapping[next]); next = row.parent;
        }
        if (next == null) { rows = chain.reverse(); complete = true; }
      }
      const messages: ImportedMessage[] = [];
      for (const raw of rows) {
        const message = object(object(raw).message), author = object(message.author), role = author.role;
        const metadata = object(message.metadata), content = object(message.content);
        if (role !== 'user' && role !== 'assistant' || metadata.is_visually_hidden_from_conversation === true ||
            typeof message.channel === 'string' && message.channel !== 'final' ||
            typeof message.recipient === 'string' && message.recipient !== 'all' || !['text', 'multimodal_text'].includes(String(content.content_type))) continue;
        if (!Array.isArray(content.parts)) continue;
        const parts = content.parts.map(value).map(part => typeof part === 'string' ? part : '[此消息含图片或附件；这里只保留公开文字，未提取图像内容]');
        const text = parts.join('\n\n');
        if (text.trim()) messages.push({ role, content: text, ...(typeof message.id === 'string' ? { id: message.id } : {}) });
      }
      if (messages.some(message => message.role === 'assistant') && (!best || messages.length >= best.messages.length))
        best = { title: typeof root.title === 'string' ? root.title : 'ChatGPT 对话', messages, complete };
    }
  }
  if (!best) throw Error('未读到 ChatGPT 公开问答，需要加载网页或改用 Markdown。');
  return best;
}
