import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMemory, nextMemoryBatch, prefixFingerprint, validMemory, loadMemory, MEMORY_KEY, memoryData, type ChatMemory } from './chatMemory';
import { parseChatsStrict, type StoredMessage } from './chatStore';
import { conversationTool } from './conversationTools';
import { executeTool, type ToolContext } from './tools';
const message=(i:number,text='原始消息'.repeat(300)):StoredMessage=>({id:`m${i}`,role:i%2?'assistant':'user',at:'2026-10-23',content:text});
const rows=()=>Array.from({length:30},(_,i)=>message(i));
const content=(ids:string[])=>({schema:'lumen.chat-memory/v1',requirements:[{text:'用户要求保留完整原文。',sources:[ids[0]]}],conclusions:[],unresolved:[]});
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)});});
describe('derived rolling memory',()=>{
 it('summarizes bounded old fragments, reuses coverage, and preserves original bytes',async()=>{
   const messages=rows(),original=JSON.stringify(messages);const generate=vi.fn(async(prompt)=>{const fragments=JSON.parse(prompt[1].content.split('新原文片段：')[1]);return JSON.stringify(content(fragments.filter((c:{role:string})=>c.role==='user').map((c:{id:string})=>c.id)));});
   const args={id:'c',messages,budget:6000,model:'synthetic',current:()=>true,generate,progress:()=>{}};
   const first=await prepareMemory(args);expect(first.memory).toBeTruthy();expect(generate.mock.calls.length).toBeLessThanOrEqual(2);expect(await validMemory(first.memory,'c',messages)).toBe(true);expect(JSON.stringify(messages)).toBe(original);
   const cursor=first.memory!.cursor;expect(first.remaining[0].id).toBe(messages[cursor.index].id);expect(memoryData(first.memory!)).toContain('不是系统指令');
   const second=await prepareMemory(args);expect(second.memory!.cursor.index*100000+second.memory!.cursor.offset).toBeGreaterThanOrEqual(cursor.index*100000+cursor.offset);expect(JSON.stringify(messages)).toBe(original);
 });
 it('append does not invalidate coverage; edited role/content/order does',async()=>{
   const messages=rows();const memory:ChatMemory={version:1,conversationId:'c',cursor:{index:2,offset:0},fingerprint:await prefixFingerprint(messages,{index:2,offset:0}),content:content(['m0']) as ChatMemory['content'],updatedAt:'',model:'synthetic'};
   expect(await validMemory(memory,'c',[...messages,message(31)])).toBe(true);
   expect(await validMemory(memory,'other',messages)).toBe(false);
   const edited=structuredClone(messages);edited[0].content+='修改';expect(await validMemory(memory,'c',edited)).toBe(false);
   expect(await validMemory({...memory,content:content(['m3']) as ChatMemory['content']},'c',messages)).toBe(false);
 });
 it('never labels assistant-only sources as user understanding or stopped answers as settled conclusions',async()=>{
   const messages=[message(0,'用户要求'),message(1,'AI的建议\n\n[回答已中止，以上可能不完整]')];
   const base:ChatMemory={version:1,conversationId:'c',cursor:{index:2,offset:0},fingerprint:await prefixFingerprint(messages,{index:2,offset:0}),content:content(['m1']) as ChatMemory['content'],updatedAt:'',model:'s'};
   expect(await validMemory(base,'c',messages)).toBe(false);
   base.content={schema:'lumen.chat-memory/v1',requirements:[],conclusions:[{text:'确定结论',sources:['m1']}],unresolved:[]};expect(await validMemory(base,'c',messages)).toBe(false);
 });
 it.each(['"','\\','\n','😀','中'])('makes progress with serialized long %s source',async character=>{
   const messages=[message(0,character.repeat(20000))];const result=nextMemoryBatch(messages,{index:0,offset:0},1,400);expect(result.chunks.length).toBe(1);expect(result.next.offset).toBeGreaterThan(0);expect(result.chunks[0].text).toBe(messages[0].content.slice(0,result.next.offset));expect(/[\uD800-\uDBFF]$/.test(result.chunks[0].text)).toBe(false);
 });
 it.each(['invalid','empty','cancel','error'])('does not cache %s output or retry',async kind=>{
   let live=true;const generate=vi.fn(async()=>{if(kind==='error')throw Error('synthetic');if(kind==='cancel')live=false;return kind==='empty'?'':kind==='invalid'?'{}':JSON.stringify(content(['m0']));});
   const result=await prepareMemory({id:'c',messages:rows(),budget:5000,model:'s',current:()=>live,generate,progress:()=>{}});expect(result.memory).toBeUndefined();expect(loadMemory('c')).toBeUndefined();expect(generate).toHaveBeenCalledTimes(1);
 });
 it('ignores corrupt derived cache and refuses corrupt originals and colliding IDs',async()=>{
   localStorage.setItem(MEMORY_KEY,JSON.stringify([{conversationId:'c'}]));expect(await validMemory(loadMemory('c'),'c',rows())).toBe(false);
   for(const raw of ['{bad',JSON.stringify({version:1,conversations:[{id:'c',messages:[null]}]}),JSON.stringify({version:1,conversations:[{id:'c',messages:[{role:'user',content:'one'},{id:'c_m_0',role:'assistant',content:'two'}]}]})])expect(()=>parseChatsStrict(raw)).toThrow('原始对话读取失败');
 });
});
describe('original conversation tools',()=>{
 it('finds a literal keyword and re-reads exact source by ID/offset',()=>{
   const m=message(0,'开始😀，精确 [a+b] 关键词。结束');const result=JSON.parse(conversationTool('search_conversation',{keywords:['[a+b]']},[m]));expect(result.hits[0].offset).toBe(m.content.indexOf('[a+b]'));
   const read=JSON.parse(conversationTool('read_conversation',{messageId:'m0',offset:result.hits[0].offset,length:5},[m]));expect(read.content).toBe('[a+b]');expect(read.nextOffset).toBe(read.offset+5);expect(conversationTool('read_conversation',{messageId:'foreign'},[m])).toContain('当前会话没有');
 });
 it('tiny response budgets never emit a non-progress cursor or oversized JSON',()=>{
   const m=message(0,'x'.repeat(1000));for(const name of ['search_conversation','read_conversation']){const result=JSON.parse(conversationTool(name,{keywords:['x']},[m],400));if(result.budgetLimited)expect(result.nextOffset).toBeNull();else expect(result.nextOffset===null||result.nextOffset>0).toBe(true);}
   expect(conversationTool('read_conversation',{messageId:'x'.repeat(2000)},[{...m,id:'x'.repeat(2000)}],400).length).toBeLessThanOrEqual(400);
 });
 it('allows own-history reads but refuses board tools after sharing is revoked',async()=>{
   const ctx:ToolContext={board:{nodes:[],edges:[]} as unknown as ToolContext['board'],readDoc:async()=>{throw Error('must not read');},shareBoard:false,conversationMessages:[message(0,'original')]};
   expect(await executeTool('read_conversation',{messageId:'m0'},ctx)).toContain('original');expect(await executeTool('list_nodes',{},ctx)).toContain('没有分享');
   ctx.shareBoard=true;ctx.allowBoard=()=>false;expect(await executeTool('apply_board_operations',{},ctx)).toContain('没有分享');
 });
});
