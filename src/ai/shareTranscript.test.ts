import { describe, expect, it } from 'vitest';
import { conversationRounds, extractGptShare, sharedMarkdown, markdownTranscript } from './shareTranscript';
import { validateSource } from './conversationImport';

function page(root: unknown) {
  const pool: unknown[] = [];
  function encode(value: unknown): number {
    const index = pool.length; pool.push(null);
    if (Array.isArray(value)) pool[index] = value.map(encode);
    else if (value && typeof value === 'object') {
      const out: Record<string, number> = {};
      for (const [key, child] of Object.entries(value)) out['_' + encode(key)] = encode(child);
      pool[index] = out;
    } else pool[index] = value;
    return index;
  }
  encode(root); return `<script>streamController.enqueue(${JSON.stringify(JSON.stringify(pool))})</script>`;
}
const message = (id: string, role: string, content: string) => ({ id, author: { role }, channel: 'final', content: { content_type: 'text', parts: [content] } });
describe('complete share transcripts', () => {
  it('recognizes explicit Markdown roles without splitting code examples or inventing rounds in an article',()=>{
    const raw='# Conversation\n\n## 提问\n\nQ\n\n## 回答\n\nA\n\n```md\n## 提问\ninside code\n```\n\n## 提问\n\nQ2\n\n## 回答\n\nA2';
    const messages=markdownTranscript(raw)!;expect(messages).toHaveLength(4);expect(messages[1].content).toContain('## 提问\ninside code');expect(markdownTranscript('# Article\n\nAn ordinary paragraph\n\n## 提问\nQ\n## 回答\nA')).toBeUndefined();
  });
  it('accepts multi-megabyte originals and reports the real high byte budget instead of silently clipping',()=>{
    expect(()=>validateSource('a'.repeat(3*1024*1024))).not.toThrow();expect(()=>validateSource('a'.repeat(32*1024*1024+1))).toThrow('32MiB');
  });
  it('reads the complete current branch instead of a short linear preview; ignores alternate branches and internal channels', () => {
    const rows = [
      { id: 'start', parent: null, message: message('u1', 'user', 'Question') },
      { id: 'answer', parent: 'start', message: message('a1', 'assistant', 'First answer') },
      { id: 'q2', parent: 'answer', message: message('u2', 'user', 'Question again') },
      { id: 'thinking', parent: 'q2', message: { ...message('thought', 'assistant', 'private reasoning'), channel: 'analysis' } },
      { id: 'end', parent: 'thinking', message: message('a2', 'assistant', 'Final answer $$x^2$$') },
    ];
    const mapping = Object.fromEntries([...rows, { id: 'alternative', parent: 'start', message: message('other', 'assistant', 'Not selected') }].map(row => [row.id, row]));
    const result = extractGptShare(page({ title: 'Topic', current_node: 'end', mapping, linear_conversation: rows.slice(0, 2) }));
    expect(result.complete).toBe(true); expect(result.messages.map(row => row.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(sharedMarkdown(result.title, result.messages)).toContain('## 第 2 轮');
    expect(result.messages.some(row => /private reasoning|Not selected/.test(row.content))).toBe(false);
  });
  it('keeps more than 500 equal messages and large text, with stable numbered round boundaries', () => {
    const messages = Array.from({ length: 1200 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: '相同正文'.repeat(100) }));
    const markdown = sharedMarkdown('Repeated', messages);
    expect(conversationRounds(messages)).toHaveLength(600); expect(markdown).toContain('## 第 600 轮');
    expect(markdown.match(/### 回答/g)).toHaveLength(600); expect(markdown.length).toBeGreaterThan(480000);
  });
  it('walks a deep pool branch iteratively and preserves text alongside image notices', () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({ id: 'node' + index, parent: index ? 'node' + (index - 1) : null, message: message('m' + index, index % 2 ? 'assistant' : 'user', 'Public text') }));
    rows[10].message.content = { content_type: 'multimodal_text', parts: ['Text with image', { content_type: 'image_asset_pointer' }] } as never;
    const result = extractGptShare(page({ title: 'Deep', current_node: 'node1199', mapping: Object.fromEntries(rows.map(row => [row.id, row])), linear_conversation: rows.slice(0, 2) }));
    expect(result.messages).toHaveLength(1200); expect(result.messages[10].content).toContain('Text with image');
    expect(result.messages[10].content).toContain('图片或附件'); expect(result.complete).toBe(true);
  });
});
