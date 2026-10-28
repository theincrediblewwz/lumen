import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import {setCatalogProviders} from './modelCatalog';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),flush:vi.fn(),release:vi.fn(),notify:vi.fn(),load:vi.fn(),resolve:vi.fn(),stream:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../sync/events',()=>({requestEditorFlush:mocks.flush,releaseEditorLock:mocks.release,notifyLibraryChanged:mocks.notify}));
vi.mock('../api',()=>({api:{boardLoad:mocks.load}}));
vi.mock('./aiClient',()=>({streamChatAgentic:mocks.stream}));
vi.mock('./aiSettings',()=>({loadAiSettingsDeferred:()=>({contextBudget:8000,baseUrl:'https://synthetic.invalid/v1',model:'synthetic',apiKey:'synthetic'}),resolveAiCredentials:mocks.resolve,isAiConfigured:()=>true}));
import {shareAddress,extractGptShare,validateTreePlan,sharedMarkdown,applyConversationTree,analyseConversation,readSharedConversation,selectedSource,conversationAnalysisBatches,CONVERSATION_BATCH_INPUT_TOKENS} from './conversationImport';
import { requestInputTokens } from './provider';
const plan={schema:'lumen.conversation-tree/v1',title:'Topic',nodes:[{reference:'r',title:'Root',summary:'Summary',markdown:'# Root\n\n$x_i$',parent:null},{reference:'c',title:'Child',summary:'Question',markdown:'## Evidence',parent:'r'}]};
it('sends only checked rounds, keeps the whole source for storage and refuses an empty selection before credentials',async()=>{
 const transcript=[{role:'user' as const,content:'Keep question'},{role:'assistant' as const,content:'Keep answer'},{role:'user' as const,content:'Exclude question'},{role:'assistant' as const,content:'Exclude answer'}];
 const source={name:'Whole',text:sharedMarkdown('Whole',transcript),transcript,selectedRounds:[1]};
 expect(selectedSource(source)).toContain('Keep answer');expect(selectedSource(source)).not.toContain('Exclude answer');
 const handle=await analyseConversation(source,0,()=>{},()=>{},()=>{});await vi.waitFor(()=>expect(mocks.stream).toHaveBeenCalled());handle.cancel();
 expect(mocks.stream.mock.calls[0][1][1].content).not.toContain('Exclude answer');expect(source.text).toContain('Exclude answer');
 mocks.resolve.mockClear();await expect(analyseConversation({...source,selectedRounds:[]},0,()=>{},()=>{},()=>{})).rejects.toThrow('至少勾选');expect(mocks.resolve).not.toHaveBeenCalled();
});
beforeEach(()=>{vi.resetAllMocks();mocks.flush.mockResolvedValue(undefined);mocks.release.mockResolvedValue(undefined);mocks.notify.mockResolvedValue(undefined);mocks.resolve.mockImplementation(async s=>s);});
afterEach(()=>{vi.useRealTimers();setCatalogProviders([]);});
describe('conversation imports',()=>{
 it('accepts an entire 512-level chain without flattening or imposing the old nine-level cap',()=>{const deep=structuredClone(plan);deep.nodes=Array.from({length:512},(_,i)=>({reference:'n'+i,title:'Level '+i,summary:'Question',markdown:'# '+i,parent:i?'n'+(i-1):null}));expect(validateTreePlan(deep).nodes[511].parent).toBe('n510');});
 it('uses fast task-specific reasoning and bounded output without editing the saved connection',async()=>{
  setCatalogProviders([{id:'synthetic',name:'Synthetic',baseUrl:'https://synthetic.invalid/v1',docs:'https://example.com/docs',models:[{id:'synthetic',window:1000000,output:131072,temperature:1,reasoning:{kind:'deepseek',levels:['none','high','max'],default:'max'}}]}]);mocks.stream.mockReturnValue({cancel:vi.fn()});
  const task=await analyseConversation({text:'Short source',name:'source.md'},12,()=>{},()=>{},()=>{});await vi.waitFor(()=>expect(mocks.stream).toHaveBeenCalledOnce());expect(mocks.stream.mock.calls[0][0]).toMatchObject({reasoningEffort:'none'});expect(mocks.stream.mock.calls[0][0].maxTokens).toBeUndefined();expect(mocks.stream.mock.calls[0][1][0].content).toContain('不限制层级和节点数量');task.cancel();
 });
 it('stops an endless thinking stream at the overall deadline and ignores late output',async()=>{
  vi.useFakeTimers();const cancel=vi.fn(),error=vi.fn(),result=vi.fn();mocks.stream.mockReturnValue({cancel});await analyseConversation({text:'Short',name:'source.md'},6,()=>{},result,error);await Promise.resolve();const handlers=mocks.stream.mock.calls[0][2];
  for(let i=0;i<3;i++){await vi.advanceTimersByTimeAsync(30000);handlers.onReasoning();}await vi.advanceTimersByTimeAsync(30001);expect(error).toHaveBeenCalledOnce();expect(error.mock.calls[0][0]).toContain('超时');expect(cancel).toHaveBeenCalledOnce();handlers.onDelta(JSON.stringify(plan));handlers.onDone();expect(result).not.toHaveBeenCalled();expect(error).toHaveBeenCalledOnce();
 });
 it('stops a silent model at the no-progress timeout and allows explicit cancel without a late plan',async()=>{
  vi.useFakeTimers();const error=vi.fn(),result=vi.fn(),cancel=vi.fn();mocks.stream.mockReturnValue({cancel});await analyseConversation({text:'source',name:'source.md'},6,()=>{},result,error);await vi.advanceTimersByTimeAsync(61000);expect(error.mock.calls[0][0]).toContain('60秒');expect(cancel).toHaveBeenCalledOnce();expect(result).not.toHaveBeenCalled();
 });
 it('recognizes only official public conversation share routes, including pasted Markdown links',()=>{
  expect(shareAddress('[share](https://chatgpt.com/share/synthetic-123)').provider).toBe('ChatGPT');expect(shareAddress('https://chat.deepseek.com/share/synthetic123?utm_source=x').url).toBe('https://chat.deepseek.com/share/synthetic123');expect(shareAddress('https://www.doubao.com/thread/synthetic_123').provider).toBe('豆包');
  for(const url of ['file:///private/key','https://chatgpt.com.evil.example/share/synthetic123','https://a:b@chatgpt.com/share/synthetic123','https://www.doubao.com/chat','https://chat.qwen.ai/s/synthetic123'])expect(()=>shareAddress(url)).toThrow();
 });
 it('decodes the modern ChatGPT reference pool and retains only user/final textual messages',()=>{
  // Synthetic shape matching publicly served React Router data; no real conversation in the repo.
  const pool=[{_1:2,_3:4},'linear_conversation',[5,14,23],'mapping',{}, { _6:7 },'message',{_8:9,_11:12},'author',{_10:13},'role','content',{_15:16,_17:18},'user',{_6:19},'content_type','text','parts',[20],{_8:21,_11:22},'Question $x_i$',{_10:24},{_15:25}, {_6:26},'assistant','thoughts',{_8:21,_11:27,_28:29},{_15:16,_17:30},'channel','final',[31],'Answer **bold**\n\n$$x^2$$'];
  const html='<script>streamController.enqueue('+JSON.stringify(JSON.stringify(pool))+')</script>';
  const result=extractGptShare(html);expect(result.messages).toEqual([{role:'user',content:'Question $x_i$'},{role:'assistant',content:'Answer **bold**\n\n$$x^2$$'}]);expect(sharedMarkdown(result.title,result.messages)).toContain('$$x^2$$');
 });
 it('does not mistake a login/shell page or executable script for conversation content',()=>{
  expect(()=>extractGptShare('<script>window.evil()</script><h1>Log in</h1>')).toThrow();
  expect(()=>sharedMarkdown('Title',[{role:'user',content:'only a question'}])).toThrow();
 });
 it('binds share reads to the requested conversation and passes cancellation identity to HTTP',async()=>{
  mocks.invoke.mockImplementation(async command=>{if(command==='conversation_share_html')throw Error('synthetic unavailable');return {url:'https://chatgpt.com/share/other-share-123',title:'Other',messages:[{role:'assistant',content:'wrong source'}]};});
  await expect(readSharedConversation('https://chatgpt.com/share/synthetic-123','share_request')).rejects.toThrow('其他对话');expect(mocks.invoke).toHaveBeenCalledWith('conversation_share_html',{url:'https://chatgpt.com/share/synthetic-123',requestId:'share_request'});
  mocks.invoke.mockClear();await expect(readSharedConversation('https://chatgpt.com/share/synthetic-123','share_cancelled',()=>true)).rejects.toThrow('已取消');expect(mocks.invoke).not.toHaveBeenCalled();
 });
 it.each(['cycle','multiple roots','path','unknown command','missing body'])('rejects invalid or unauthorized model output: %s',kind=>{
  const invalid=structuredClone(plan);if(kind==='cycle')invalid.nodes[0].parent='c' as never;
  if(kind==='multiple roots')invalid.nodes[1].parent=null as never;if(kind==='path')invalid.nodes[0].reference='../escape';
  if(kind==='unknown command')Object.assign(invalid.nodes[0],{destination:'/private/file'});if(kind==='missing body')invalid.nodes[0].markdown='';expect(()=>validateTreePlan(invalid)).toThrow();
 });
 it('splits large Markdown losslessly at bounded input sizes, including long lines and surrogate pairs',()=>{
  for(const text of ['研究资料\n\n'.repeat(20000),'😀公式\\"'.repeat(15000)]){
   const batches=conversationAnalysisBatches(text,1000000,'Synthetic system');
   expect(batches.length).toBeGreaterThan(1);expect(batches.map(b=>b.text).join('')).toBe(text);
   let end=0;for(const batch of batches){expect(batch.start).toBe(end);expect(batch.end).toBeGreaterThan(end);expect(batch.text).toBe(text.slice(batch.start,batch.end));expect(batch.text).not.toMatch(/[\uD800-\uDBFF]$/);end=batch.end;
    expect(requestInputTokens([{role:'system',content:'Synthetic system'},{role:'user',content:batch.text}])).toBeLessThan(CONVERSATION_BATCH_INPUT_TOKENS);
   }expect(end).toBe(text.length);
  }
 });
 it('analyses all selected content sequentially and merges subtrees locally without a second provider summary',async()=>{
  const result=vi.fn(),error=vi.fn(),progress=vi.fn();let active=0,maxActive=0;
  mocks.stream.mockImplementation((_settings,_messages,handlers)=>{active++;maxActive=Math.max(maxActive,active);queueMicrotask(()=>{handlers.onRoundStart?.();handlers.onDelta(JSON.stringify(plan));active--;handlers.onDone();});return {cancel:vi.fn()};});
  const text=Array.from({length:23302},(_,i)=>`## Question ${i}\n数学研究资料😀\n\n`).join('');
  const source={text,name:'large.md'};await analyseConversation(source,12,progress,result,error);
  await vi.waitFor(()=>expect(result).toHaveBeenCalledOnce());expect(error).not.toHaveBeenCalled();expect(maxActive).toBe(1);
  const calls=mocks.stream.mock.calls;expect(calls.length).toBeGreaterThan(1);
  expect(calls.map(call=>call[1][1].content.split('\n\n').slice(1).join('\n\n')).join('')).toBe(text);
  for(const call of calls)expect(requestInputTokens(call[1])).toBeLessThanOrEqual(8000);
  const merged=validateTreePlan(result.mock.calls[0][0]);expect(merged.nodes).toHaveLength(1+2*calls.length);expect(merged.nodes.filter(n=>n.parent===null)).toHaveLength(1);expect(new Set(merged.nodes.map(n=>n.reference)).size).toBe(merged.nodes.length);
  expect(progress.mock.calls.some(([s])=>s.includes(`第 ${calls.length}/${calls.length} 批完成`))).toBe(true);expect(source.text).toBe(text);expect(mocks.invoke).not.toHaveBeenCalled();
 });
 it('does not return or write a partial plan when a later batch fails, or repeat successful requests',async()=>{
  const result=vi.fn(),error=vi.fn();let index=0;
  mocks.stream.mockImplementation((_settings,_messages,handlers)=>{const batch=++index;queueMicrotask(()=>{if(batch===1){handlers.onDelta(JSON.stringify(plan));handlers.onDone();}else handlers.onError('synthetic capacity failure');});return {cancel:vi.fn()};});
  await analyseConversation({text:'研究材料'.repeat(25000),name:'large.md'},12,()=>{},result,error);
  await vi.waitFor(()=>expect(error).toHaveBeenCalledOnce());expect(mocks.stream).toHaveBeenCalledTimes(2);expect(error.mock.calls[0][0]).toContain('第 2/');expect(result).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
 });
 it('handles synchronous batch completion without recursion or a lost final callback',async()=>{
  const result=vi.fn(),error=vi.fn();mocks.stream.mockImplementation((_settings,_messages,handlers)=>{handlers.onDelta(JSON.stringify(plan));handlers.onDone();return {cancel:vi.fn()};});
  await analyseConversation({text:'研究材料'.repeat(25000),name:'large.md'},12,()=>{},result,error);
  await vi.waitFor(()=>expect(result).toHaveBeenCalledOnce());expect(mocks.stream.mock.calls.length).toBeGreaterThan(1);expect(error).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
 });
 it('cancels the active batch and ignores late output without starting the remaining batches',async()=>{
  const result=vi.fn(),error=vi.fn(),cancel=vi.fn();mocks.stream.mockReturnValue({cancel});
  const task=await analyseConversation({text:'研究材料'.repeat(25000),name:'large.md'},12,()=>{},result,error);
  await vi.waitFor(()=>expect(mocks.stream).toHaveBeenCalledOnce());const handlers=mocks.stream.mock.calls[0][2];handlers.onDelta(JSON.stringify(plan));handlers.onDone();
  await vi.waitFor(()=>expect(mocks.stream).toHaveBeenCalledTimes(2));task.cancel();const late=mocks.stream.mock.calls[1][2];late.onDelta(JSON.stringify(plan));late.onDone();await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();expect(mocks.stream).toHaveBeenCalledTimes(2);expect(result).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
 });
 it('keeps a visible retry wait out of inactivity and overall processing timeouts',async()=>{
  vi.useFakeTimers();const result=vi.fn(),error=vi.fn();mocks.stream.mockReturnValue({cancel:vi.fn()});await analyseConversation({text:'source',name:'small.md'},0,()=>{},result,error);await Promise.resolve();await Promise.resolve();
  const handlers=mocks.stream.mock.calls[0][2];await vi.advanceTimersByTimeAsync(59000);handlers.onRetry({attempt:1,maxRetries:3,delayMs:60000,reason:'服务暂忙'});await vi.advanceTimersByTimeAsync(61000);expect(error).not.toHaveBeenCalled();
  handlers.onDelta(JSON.stringify(plan));handlers.onDone();await Promise.resolve();expect(result).toHaveBeenCalledOnce();expect(error).not.toHaveBeenCalled();
 });
 it('does not start inference if cancelled during credential resolution',async()=>{
  let cancelled=false;mocks.resolve.mockImplementation(async s=>{cancelled=true;return s;});await analyseConversation({text:'source',name:'small.md'},12,()=>{},()=>{},()=>{},()=>cancelled);expect(mocks.stream).not.toHaveBeenCalled();
 });
 it('commits only after a presentation-safe comparison and releases the main editor on rejection',async()=>{
  const board={version:1,id:'b',projectId:'p',name:'Original',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'now',updated_at:'now'};mocks.load.mockResolvedValue({...board,name:'User changed this'});
  await expect(applyConversationTree('p',board,{scope:'local',projectRevision:'project'}, {text:'Original',name:'source.md'},validateTreePlan(plan),'','request')).rejects.toThrow('白板内容已变化');expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('recovers a lost commit response using the original CAS, never a changed board revision',async()=>{
  const board={version:1,id:'b',projectId:'p',name:'Original',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'now',updated_at:'now',_disk_revision:'before'};const committed={...board,name:'Committed',_disk_revision:'after'};mocks.load.mockResolvedValue(committed);mocks.invoke.mockResolvedValue({board:committed,reused:true});
  await applyConversationTree('p',board,{scope:'local',projectRevision:'project'},{text:'Original',name:'source.md'},validateTreePlan(plan),'','same_request');expect(mocks.invoke).toHaveBeenCalledWith('conversation_import_apply',expect.objectContaining({requestId:'same_request',expectedRevision:'before'}));expect(mocks.release).toHaveBeenCalledOnce();
  mocks.invoke.mockRejectedValue(new Error('白板内容已改变，导入尚未写入'));await expect(applyConversationTree('p',board,{scope:'local',projectRevision:'project'},{text:'Original',name:'source.md'},validateTreePlan(plan),'','new_request')).rejects.toThrow('白板内容已改变');expect(mocks.invoke.mock.calls.at(-1)?.[1].expectedRevision).toBe('before');
 });
});
it('faithful analysis only accepts metadata and attaches exact local originals',async()=>{
 const text='## 第 1 条回答\r\n\r\nOriginal A $x_i$  \r\n\r\n## 第 2 条回答\r\n\r\nOriginal B\r\n\r\n',result=vi.fn(),error=vi.fn();
 mocks.stream.mockImplementation((_settings,messages,handlers)=>{const input=JSON.parse(messages[1].content);queueMicrotask(()=>{handlers.onDelta(JSON.stringify({schema:'lumen.faithful-metadata/v1',answers:input.parts.map((part:{id:string})=>({id:part.id,title:'Summary title',summary:'Understanding',guide:'Short AI guide',parent:null,reason:'Suggested overview child'}))}));handlers.onDone();});return {cancel:vi.fn()};});
 await analyseConversation({text,name:'numbered.md'},0,()=>{},result,error,()=>false,false,'faithful');await vi.waitFor(()=>expect(result).toHaveBeenCalledOnce());expect(error).not.toHaveBeenCalled();const next=result.mock.calls[0][0];expect(next.mode).toBe('faithful');expect(next.nodes).toHaveLength(3);expect(next.nodes[1].original.content).toBe('\r\nOriginal A $x_i$  \r\n\r\n');expect(next.nodes[2].original.content).toBe('\r\nOriginal B\r\n\r\n');expect(mocks.invoke).not.toHaveBeenCalled();
});
it('rejects faithful mode or original fields supplied by a reconstructing model',async()=>{
 const result=vi.fn(),error=vi.fn(),forged={...structuredClone(plan),mode:'faithful',nodes:plan.nodes.map(n=>({...n,original:{id:n.reference,content:'source'}}))};
 mocks.stream.mockImplementation((_settings,_messages,handlers)=>{queueMicrotask(()=>{handlers.onDelta(JSON.stringify(forged));handlers.onDone();});return {cancel:vi.fn()};});
 await analyseConversation({text:'source',name:'source.md'},0,()=>{},result,error);await vi.waitFor(()=>expect(error).toHaveBeenCalledOnce());expect(result).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
});
it('rejects ambiguous faithful Markdown before credentials or inference',async()=>{
 await expect(analyseConversation({text:'# Article\n## Topic\nParagraph',name:'article.md'},0,()=>{},()=>{},()=>{},()=>false,false,'faithful')).rejects.toThrow('明确的回答分隔');expect(mocks.resolve).not.toHaveBeenCalled();expect(mocks.stream).not.toHaveBeenCalled();
});
it('refuses altered or missing faithful originals before locking or native writes',async()=>{
 const text='## 第 1 条回答\nExact source\n',faithful={schema:'lumen.conversation-tree/v1' as const,mode:'faithful' as const,title:'Topic',nodes:[{reference:'root',title:'Overview',summary:'',markdown:'Overview',parent:null},{reference:'answer_1',title:'Answer',summary:'',markdown:'Guide',parent:'root',original:{id:'answer_1',content:'changed source'}}]};
 await expect(applyConversationTree('p',undefined,{scope:'local',projectRevision:'project'},{text,name:'source.md'},faithful,'','request')).rejects.toThrow('已选来源不一致');expect(mocks.flush).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
});
