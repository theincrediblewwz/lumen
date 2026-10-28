import {describe,it,expect} from 'vitest';
import {captureKey,conversationMarkdown,selectionKey,completedCaptureTurns,captureTurnsForSelection,parseConversationLink} from './chatCapture';
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

describe('complete turn selection',()=>{
  const second=[{...messages[0],id:'q2',content:'第二个问题'},{...messages[1],id:'a2',content:'第二轮回答'}];
  const third=[{...messages[0],id:'q3',content:'第三个问题'},{...messages[1],id:'a3',content:'第三轮回答'}];
  it('selecting either a question or an answer saves the same complete turn',async()=>{
    const q=captureTurnsForSelection([...messages,...second],new Set(['m1']));
    const a=captureTurnsForSelection([...messages,...second],new Set(['m2']));
    expect(q).toEqual(messages);expect(a).toEqual(q);
    expect(await captureKey('c1',a)).toBe(await captureKey('c1',q));
  });
  it('preserves chronology and complete Markdown across disjoint selected turns',()=>{
    const selected=captureTurnsForSelection([...messages,...second,...third],new Set(['a3','m1']));
    expect(selected.map(m=>m.id)).toEqual(['m1','m2','q3','a3']);
    const markdown=conversationMarkdown('笔记','c1',selected);
    expect(markdown).toContain(messages[1].content);expect(markdown).not.toContain('第二轮回答');
  });
  it('does not save unanswered, failed or unfinished turns',()=>{
    const candidates=[...messages,...second.map(m=>m.role==='assistant'?{...m,error:true}:m),...third.map(m=>m.role==='assistant'?{...m,streaming:true}:m),{...messages[0],id:'pending'}];
    expect(completedCaptureTurns(candidates)).toEqual([messages]);
    expect(captureTurnsForSelection(candidates,new Set(['q2','q3','pending']))).toEqual([]);
  });
  it('source links carry exact conversation/message identity and reject invalid targets',()=>{
    const source='lumen://conversation/c_123?messages=m_1,m_2&project=p_1&board=b_1';
    expect(parseConversationLink(source)).toEqual({projectId:'p_1',boardId:'b_1',conversationId:'c_123',messageIds:['m_1','m_2']});
    expect(parseConversationLink('lumen://conversation/c_123?messages=m_1',{projectId:'p_1',boardId:'b_1'})?.messageIds).toEqual(['m_1']);
    for(const link of ['javascript:alert(1)','https://example.com','lumen://conversation/%2E%2E?project=p&board=b','lumen://conversation/c?messages=%3Cscript%3E&project=p&board=b'])expect(parseConversationLink(link)).toBeNull();
  });
});
