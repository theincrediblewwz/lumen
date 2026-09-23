import {describe,it,expect} from 'vitest';
import {captureKey,conversationMarkdown,selectionKey} from './chatCapture';
const messages=[{id:'m1',role:'user' as const,content:'问题',at:'2026-09-22'},{id:'m2',role:'assistant' as const,content:'# 回答\n\n|a|b|\n|-|-|\n|1|2|',at:'2026-09-22'}];
describe('chat to document',()=>{
  it('preserves Markdown verbatim, provenance and parent reference',()=>{
    const before=JSON.stringify(messages);const md=conversationMarkdown('笔记','c1',messages,'n1');
    expect(md).toContain(messages[1].content);expect(md).toContain('lumen://conversation/c1?messages=m1,m2');expect(md).toContain('[[node:n1]]');expect(JSON.stringify(messages)).toBe(before);
  });
  it('deduplicates selected immutable message IDs using the Android source key',async()=>{
    expect(await captureKey('c1',messages)).toBe(await captureKey('c1',messages));
    expect(selectionKey('c1',messages)).toBe('chat:c1:m1,m2');
    expect(await captureKey('c1',messages)).not.toBe(await captureKey('c1',[messages[0]]));
  });
  it('rejects empty and failed selections',()=>{
    expect(()=>conversationMarkdown('x','c1',[])).toThrow();expect(()=>conversationMarkdown('x','c1',[{...messages[0],error:true}])).toThrow();
  });
});
