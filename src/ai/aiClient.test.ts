import { afterEach, expect, it, vi } from 'vitest';
import { streamChatAgentic, type AiRoundTiming, type AiRunLimit } from './aiClient';
import { DEFAULT_AI_SETTINGS } from './aiSettings';
import type { ToolContext } from './tools';
import { setCatalogProviders } from './modelCatalog';
import { requestInputTokens, type ChatMessage } from './provider';

afterEach(() => {vi.unstubAllGlobals();setCatalogProviders([]);});
const settings = { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://synthetic.invalid/v1', apiKey: 'mock-key' };

it('measures each request and tool without reporting the contents of thinking, arguments, or answers', async () => {
  const event = (delta: Record<string, unknown>, finish_reason: string) => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n';
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(event({ tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'test', arguments: '{"source":"synthetic-private-argument"}' } }] }, 'tool_calls')))
    .mockResolvedValueOnce(new Response(event({ reasoning_content: 'synthetic-private-thought', content: 'synthetic-private-answer' }, 'stop'))));
  const rounds = new Map<number, AiRoundTiming>();
  const toolTiming = vi.fn();
  await new Promise<void>((resolve, reject) => streamChatAgentic(settings, [], {
    onDelta: () => {}, onDone: resolve, onError: reject,
    onRoundTiming: row => rounds.set(row.round, row), onToolTiming: toolTiming,
    tools: { definitions: [{ type: 'function', function: { name: 'test' } }], execute: async () => 'synthetic-private-value' },
  }));
  expect(rounds.size).toBe(2);
  expect(rounds.get(1)?.firstTextMs).toBeUndefined();
  const final = rounds.get(2)!;
  expect(final.headersMs).toBeLessThanOrEqual(final.firstBodyMs!);
  expect(final.firstReasoningMs).toBeLessThanOrEqual(final.firstTextMs!);
  expect(final.firstTextMs).toBeLessThanOrEqual(final.streamMs!);
  expect(toolTiming).toHaveBeenCalledOnce();
  expect(toolTiming.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify([...rounds])).not.toContain('synthetic-private');
});

it.each([
 ['thinking length',{reasoning_content:'private thought'},'length',true,'思考已达到输出上限'],
 ['partial length',{content:'{"schema":'},'length',true,'树结构尚未完整'],
 ['complete length',{content:'{}'},'length',true,'树结构尚未完整'],
 ['thinking stop',{reasoning_content:'private thought'},'stop',true,'仅返回思考'],
 ['empty stop',{},'stop',true,'未返回树结构'],
 ['abrupt stream',{content:'{}'},null,false,'提前结束'],
 ['normal',{content:'{}'},'stop',true,'done'],
] as const)('structured import classifies %s without retrying or treating truncated JSON as complete',async(_name,delta,finish,terminal,expected)=>{
 const payload='data: '+JSON.stringify({choices:[{delta,finish_reason:finish}]})+'\n\n'+(terminal?'data: [DONE]\n\n':'');const fetcher=vi.fn(async()=>new Response(payload));vi.stubGlobal('fetch',fetcher);const outcome=await new Promise<string>(resolve=>streamChatAgentic(settings,[{role:'user',content:'source'}],{purpose:'structured',onDelta:()=>{},onDone:()=>resolve('done'),onError:resolve}));expect(outcome).toContain(expected);expect(fetcher).toHaveBeenCalledOnce();
});
it('surfaces streamed provider errors and reports only reasoning counts',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\n\ndata: {"error":{"message":"quota limit"}}\n\n')));const reasoning=vi.fn();const result=await new Promise<string>(resolve=>streamChatAgentic(settings,[],{purpose:'structured',onDelta:()=>{},onReasoning:reasoning,onDone:()=>resolve('wrong success'),onError:resolve}));expect(result).toContain('quota limit');expect(reasoning.mock.calls[0]).toEqual([15]);});

it('reports a thinking-only empty completion rather than silently succeeding',async()=>{
 const fetcher=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"reasoning_content":"not visible"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'));vi.stubGlobal('fetch',fetcher);
 const error=await new Promise<string>((resolve,reject)=>streamChatAgentic(settings,[{role:'user',content:'question'}],{onDelta:()=>{},onDone:()=>reject(Error('empty success')),onError:resolve}));expect(error).toContain('未返回可见回答');expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps board operation arguments out of visible deltas and refuses malformed operation JSON',async()=>{
 for(const valid of [true,false]){
 const batch={schema:'lumen.board-operations/v1',operations:[{type:'create_node',reference:'new',title:'方向'}]};
 const chunk=JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'write-call',type:'function',function:{name:'apply_board_operations',arguments:valid?JSON.stringify(batch):'{broken'}}]},finish_reason:'tool_calls'}]});
 const end=JSON.stringify({choices:[{delta:{content:'已创建方向。'},finish_reason:'stop'}]});const fetcher=vi.fn().mockResolvedValueOnce(new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`)).mockResolvedValueOnce(new Response(`data: ${end}\n\ndata: [DONE]\n\n`));vi.stubGlobal('fetch',fetcher);
 const apply=vi.fn(async()=>'{"created":1}');const tools:ToolContext={board:{version:1,id:'b',projectId:'p',name:'合成',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'',updated_at:''},readDoc:async()=>'',applyOperations:apply};let visible='';
 const result=await new Promise<string>(resolve=>streamChatAgentic(settings,[{role:'user',content:'建节点'}],{onDelta:d=>{visible+=d},onDone:()=>resolve('done'),onError:resolve},tools));
 if(valid){expect(apply).toHaveBeenCalledWith(batch,'write-call');expect(visible).toBe('已创建方向。');expect(result).toBe('done');}else{expect(apply).not.toHaveBeenCalled();expect(result).toContain('有效 JSON');}
 }
});

it('freezes both known and unknown model capabilities across a catalogue update between tool rounds',async()=>{
 for(const known of [true,false]){
  setCatalogProviders([]);
  const model=known?'glm-5.3':'new-model-unknown-at-start';
  const tool=JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'tool',type:'function',function:{name:'read_board_outline',arguments:'{}'}}]},finish_reason:'tool_calls'}]});const end=JSON.stringify({choices:[{delta:{content:'答案'},finish_reason:'stop'}]});
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(`data: ${tool}\n\ndata: [DONE]\n\n`)).mockResolvedValueOnce(new Response(`data: ${end}\n\ndata: [DONE]\n\n`));vi.stubGlobal('fetch',fetcher);
  const tools:ToolContext={board:{version:1,id:'board',projectId:'project',name:'合成',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'',updated_at:''},readDoc:async()=>''};let rounds=0;
  await new Promise<void>((resolve,reject)=>{streamChatAgentic({...settings,model,maxTokens:20000,contextBudget:100000},[{role:'user',content:'合成问题'}],{onDelta:()=>{},onDone:resolve,onError:reject,beforeRequest:async()=>{if(++rounds===2)setCatalogProviders([{id:'synthetic-new',name:'Synthetic',baseUrl:'https://synthetic.invalid/v1',docs:'https://example.com/docs',models:[{id:model,window:8192,output:100,temperature:0.1,omitTemperature:true}]}]);}},tools);});
  expect(fetcher).toHaveBeenCalledTimes(2);const first=JSON.parse(fetcher.mock.calls[0][1].body);const second=JSON.parse(fetcher.mock.calls[1][1].body);expect(second.max_tokens).toBe(first.max_tokens);expect(second.temperature).toBe(first.temperature);expect(second.reasoning_effort).toBe(first.reasoning_effort);
 }
});

it('a revoked permission gate stops before any provider request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const error = await new Promise<string>((resolve, reject) => {
    streamChatAgentic(settings, [{ role: 'user', content: '问题' }], {
      beforeRequest: async () => { throw new Error('知识引用权限已关闭'); },
      onDelta: () => {}, onDone: () => reject(new Error('unexpected success')), onError: resolve,
    });
  });
  expect(error).toContain('权限已关闭'); expect(fetcher).not.toHaveBeenCalled();
});

it('revoking permission after a tool round prevents the second provider request', async () => {
  const chunk = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'read_board_outline', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  const fetcher = vi.fn(async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetcher);
  const tools: ToolContext = { board: { version: 1, id: 'board', projectId: 'project', name: '合成白板', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, created_at: '', updated_at: '' }, readDoc: async () => '' };
  let checks = 0;
  const error = await new Promise<string>((resolve, reject) => {
    streamChatAgentic(settings, [{ role: 'user', content: '问题' }], {
      beforeRequest: async () => { if (++checks === 2) throw new Error('知识内容已变化'); },
      onDelta: () => {}, onDone: () => reject(new Error('unexpected success')), onError: resolve,
    }, tools);
  });
  expect(error).toContain('内容已变化'); expect(checks).toBe(2); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('uses current completion parameters and carries thinking through a real tool continuation', async () => {
  const tool = JSON.stringify({ choices: [{ delta: { reasoning_content: 'synthetic-private-thinking', tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'read_board_outline', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  const end = JSON.stringify({ choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(`data: ${tool}\n\ndata: [DONE]\n\n`)).mockResolvedValueOnce(new Response(`data: ${end}\n\ndata: [DONE]\n\n`));
  vi.stubGlobal('fetch', fetcher);
  const tools: ToolContext = { board: { version: 1, id: 'board', projectId: 'project', name: '合成白板', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, created_at: '', updated_at: '' }, readDoc: async () => '' };
  const content: string[] = [];
  await new Promise<void>((resolve, reject) => {
    streamChatAgentic({ ...settings, model: 'mimo-v2.6-pro', maxTokens: 131072 }, [{ role: 'user', content: '问题' }], { onDelta: text => content.push(text), onDone: resolve, onError: reject }, tools);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const body = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(body.messages[1].reasoning_content).toBe('synthetic-private-thinking');
  expect(body.max_completion_tokens).toBe(131072);
  expect(body.temperature).toBeUndefined();
  expect(content.join('')).toBe('答案');
});

it('reads a bounded document segment within the input allowance and keeps the remaining source on demand', async () => {
  const chunk = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'read_node_doc', arguments: '{"nodeId":"node"}' } }] }, finish_reason: 'tool_calls' }] });
  const end=JSON.stringify({choices:[{delta:{content:'已查阅一段，其他部分尚未读取。'},finish_reason:'stop'}]});
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`)).mockResolvedValueOnce(new Response(`data: ${end}\n\ndata: [DONE]\n\n`));
  vi.stubGlobal('fetch', fetcher);
  const tools: ToolContext = { board: { version: 1, id: 'board', projectId: 'project', name: '合成白板', nodes: [{ id: 'node', title: '材料', x: 0, y: 0, w: 200, docs: [{ title: '材料', path: 'synthetic.md' }], created_at: '', updated_at: '' }], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, created_at: '', updated_at: '' }, readDoc: async () => '合成超长材料'.repeat(10000) };
  await new Promise<void>((resolve, reject) => {
    streamChatAgentic({ ...settings, contextBudget: 2000 }, [{ role: 'user', content: '问题' }], { onDelta: () => {}, onDone: resolve, onError: reject }, tools);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const body=JSON.parse(fetcher.mock.calls[1][1].body);const result=body.messages.find((m:{role:string})=>m.role==='tool').content;expect(result).toContain('nextOffset=');expect(result).toContain('只是正文片段');expect(result.length).toBeLessThan(2000);
});

it('reserves a final answer after the tool limit, keeps schemas stable, and never executes a fifth tool batch',async()=>{
 for(const respectsLimit of [true,false]){
  const fetcher=vi.fn(async(_url,init)=>{const request=JSON.parse(init.body);const final=request.tool_choice==='none';const delta=final&&respectsLimit?{content:'已完成查阅；仍有未确定部分。'}:{tool_calls:[{index:0,id:'call-'+fetcher.mock.calls.length,type:'function',function:{name:'read_board_outline',arguments:'{}'}}]};return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:'tool_calls'in delta?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});vi.stubGlobal('fetch',fetcher);
  const tools:ToolContext={board:{version:1,id:'b',projectId:'p',name:'合成',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'',updated_at:''},readDoc:async()=>''};const starts=vi.fn();let visible='';
  const result=await new Promise<string>(resolve=>streamChatAgentic({...settings,contextBudget:100000,toolRounds:4},[{role:'user',content:'查阅后说明'}],{onDelta:d=>{visible+=d;},onToolStart:starts,onDone:()=>resolve('done'),onError:resolve},tools));expect(fetcher).toHaveBeenCalledTimes(5);expect(starts).toHaveBeenCalledTimes(4);const bodies=fetcher.mock.calls.map(call=>JSON.parse(call[1].body));expect(bodies.at(-1).tool_choice).toBe('none');expect(bodies.at(-1).tools).toEqual(bodies[0].tools);
  if(respectsLimit){expect(result).toBe('done');expect(visible).toContain('未确定');}else expect(result).toContain('上限');
 }
});

const syntheticBoard: ToolContext['board'] = {
  version: 1, id: 'board', projectId: 'project', name: '合成', nodes: [], edges: [],
  viewport: { x: 0, y: 0, zoom: 1 }, created_at: '', updated_at: '',
};

function providerReply(delta: Record<string, unknown>, finish_reason: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`);
}

function syntheticWrite(round: number, markdown: string) {
  return { index: 0, id: `write-${round}`, type: 'function', function: {
    name: 'apply_board_operations', arguments: JSON.stringify({ schema: 'lumen.board-operations/v1', operations: [
      { type: 'create_node', reference: 'new', title: `节点 ${round}`, markdown },
    ] }),
  } };
}

it('continues more than the former four batches under a small budget and keeps whole recent tool turns', async () => {
  const requests: { messages: ChatMessage[]; tools: unknown[]; tool_choice: string }[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const round = requests.length;
    if (round > 9) return providerReply({ content: '九个节点已保存。' }, 'stop');
    const size = round === 2 ? 1800 : round === 8 ? 950 : 380;
    return providerReply({ tool_calls: [syntheticWrite(round, '合成材料'.repeat(size))], reasoning_content: `思考 ${round}` }, 'tool_calls');
  });
  vi.stubGlobal('fetch', fetcher);
  const apply = vi.fn(async (_args, id) => JSON.stringify({ summary: `${id} 已保存`, nodes: { new: `n_${id}` } }));
  const pinned = '最新问题原样保留。';
  const budget = 5000;
  await new Promise<void>((resolve, reject) => streamChatAgentic({ ...settings, contextBudget: budget }, [{ role: 'user', content: pinned }], {
    onDelta: () => {}, onDone: resolve, onError: reject, onLimit: notice => reject(Error(notice.message)),
  }, { board: syntheticBoard, readDoc: async () => '', applyOperations: apply }));
  expect(apply).toHaveBeenCalledTimes(9);
  expect(requests).toHaveLength(10);
  for (const request of requests) {
    expect(requestInputTokens(request.messages, request.tools)).toBeLessThanOrEqual(budget);
    expect(request.messages).toContainEqual({ role: 'user', content: pinned });
    expect(request.tool_choice).toBe('auto');
    expect(request.messages.flatMap(m => m.tool_calls?.map(call => call.id) ?? [])).toEqual(request.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  }
  const final = requests.at(-1)!.messages;
  expect(final.find(m => m.content.includes('较早的'))?.content).toContain('n_write-2');
  expect(requests[8].messages.find(m => m.tool_calls?.[0].id === 'write-8')?.reasoning_content).toBe('思考 8');
  expect(final.find(m => m.tool_calls?.[0].id === 'write-9')?.reasoning_content).toBe('思考 9');
});

it.each(['toolRounds', 'writeBatches', 'output'] as const)('reports the specific %s limit and never applies the refused call', async reason => {
  let round = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    round++;
    const delta = { tool_calls: [syntheticWrite(round, '合成')] };
    return reason === 'output' && round === 2 ? providerReply({ ...delta, content: '部分回答' }, 'length') : providerReply(delta, 'tool_calls');
  }));
  const apply = vi.fn(async () => '{"summary":"已保存"}');
  const notice = await new Promise<AiRunLimit>((resolve, reject) => streamChatAgentic({ ...settings,
    toolRounds: reason === 'toolRounds' ? 1 : 8, boardWriteBatches: reason === 'writeBatches' ? 1 : 8,
  }, [{ role: 'user', content: '合成任务' }], {
    onDelta: () => {}, onDone: () => reject(Error('limit reported as complete')), onError: reject, onLimit: resolve,
  }, { board: syntheticBoard, readDoc: async () => '', applyOperations: apply }));
  expect(notice.reason).toBe(reason);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(round).toBe(reason === 'writeBatches' ? 3 : 2);
});
