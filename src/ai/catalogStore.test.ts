import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { streamChatAgentic } from './aiClient';
import { validateProposal, applyCatalogue, loadCatalogue, rollbackCatalogue, publicUrl, proposalDifferences } from './catalogStore';
import { pageText, searchLinks, startCatalogAssistant, testConnection } from './catalogAssistant';
import { setCatalogProviders, getProviderPresets } from './modelCatalog';
import { DEFAULT_AI_SETTINGS, loadAiSettings } from './aiSettings';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
vi.mock('./aiClient',()=>({streamChatAgentic:vi.fn(()=>({cancel:vi.fn()}))}));
const url='https://example.com/docs/model';
const quote='Model public-next has a context window of 2097152 tokens and maximum output 262144 tokens.';
const proposal={schema:'lumen.catalog-proposal/v1',summary:'新增经过公开资料核对的模型',providers:[{id:'public-next',name:'Public Next',baseUrl:'https://api.example.com/v1',docs:url,models:[{id:'public-next',window:2097152,output:262144,omitTemperature:true,reasoning:{kind:'effort',levels:['low','high','max'],default:'high'}}],sources:[{url,quote}]}]};
let storage:Record<string,string>={};
beforeEach(()=>{vi.clearAllMocks();setCatalogProviders([]);storage={};vi.stubGlobal('localStorage',{getItem:(k:string)=>storage[k]??null,setItem:(k:string,v:string)=>{storage[k]=v;},removeItem:(k:string)=>{delete storage[k];},key:(i:number)=>Object.keys(storage)[i]??null,get length(){return Object.keys(storage).length;}});});
afterEach(()=>{setCatalogProviders([]);vi.unstubAllGlobals();});
const validated=()=>validateProposal(JSON.stringify(proposal),[{url,text:quote}]);
it('requires actual read evidence and rejects secret/header/executable fields',()=>{
  expect(validated().providers[0].models[0].window).toBe(2097152);
  expect(()=>validateProposal(JSON.stringify(proposal),[])).toThrow('未实际读取');
  expect(()=>validateProposal(JSON.stringify({...proposal,providers:[{...proposal.providers[0],apiKey:'injected'}]}),[{url,text:quote}])).toThrow('不允许');
  expect(()=>validateProposal(JSON.stringify({...proposal,providers:[{...proposal.providers[0],models:[{...proposal.providers[0].models[0],extra:{headers:'injected'}}]}]}),[{url,text:quote}])).toThrow('不允许');
  const invalid=structuredClone(proposal);invalid.providers[0].models[0].window=-2;
  expect(()=>validateProposal(JSON.stringify(invalid),[{url,text:quote}])).toThrow('整数');
  expect(proposalDifferences(validated()).some(d=>d.path.includes('接口地址'))).toBe(true);
});
it('rejects nonpublic URL shapes and never treats search snippets as read evidence',()=>{
  for(const address of ['http://example.com','https://u:p@example.com','https://127.0.0.1','https://[::1]','file:///secret','https://service.local','https://host:444'])expect(()=>publicUrl(address)).toThrow();
  expect(searchLinks('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Official <b>models</b></a>')).toEqual([{title:'Official models',url:'https://example.com/docs'}]);
  expect(()=>searchLinks('<html>challenge</html>')).toThrow('搜索');
});
it('apply and rollback update only public catalogue; all connection/key records remain byte-for-byte',async()=>{
  storage['lumen.ai.v1']=JSON.stringify({...DEFAULT_AI_SETTINGS,baseUrl:'https://private-gateway.invalid/v1',model:'my-personal-model',contextBudget:987654});
  storage['lumen.ai.key.fallback']='synthetic-credential';
  storage['personal-knowledge-marker']='unchanged';const original={...storage};
  let version=0;let records:unknown[]=[];let previous:unknown[]=[];
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{},dispatchEvent:vi.fn()});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const request=args as {expectedRevision:number;providers:unknown[]};
    if(command==='model_catalog_apply'){if(request.expectedRevision!==version)throw Error('版本冲突');previous=records;records=request.providers;version++;}
    else if(command==='model_catalog_rollback'){if(request.expectedRevision!==version)throw Error('版本冲突');[records,previous]=[previous,records];version++;}
    else if(command!=='model_catalog_load')throw Error('Unexpected access to private command');
    return {revision:version,providers:records,canRollback:version>0};
  });
  await loadCatalogue();await applyCatalogue(validated(),0);
  expect(getProviderPresets().some(p=>p.id==='public-next')).toBe(true);
  for(const [key,value]of Object.entries(original))expect(storage[key]).toBe(value);
  expect(loadAiSettings().contextBudget).toBe(987654);
  await expect(applyCatalogue(validated(),0)).rejects.toThrow('版本冲突');
  await rollbackCatalogue(1);expect(getProviderPresets().some(p=>p.id==='public-next')).toBe(false);
  for(const [key,value]of Object.entries(original))expect(storage[key]).toBe(value);
  expect(vi.mocked(invoke).mock.calls.every(([command])=>String(command).startsWith('model_catalog_'))).toBe(true);
});
it('catalogue AI receives only public data and cannot apply, read credentials or use board tools',async()=>{
  vi.mocked(invoke).mockResolvedValue('<html><body>'+quote+'</body></html>');
  const success=vi.fn();const failure=vi.fn();
  startCatalogAssistant({...DEFAULT_AI_SETTINGS,baseUrl:'https://private-personal-gateway.invalid/v1',apiKey:'qa-private-key'},'查公开模型',vi.fn(),success,failure);
  const call=vi.mocked(streamChatAgentic).mock.calls[0];
  const messages=JSON.stringify(call[1]);expect(messages).not.toContain('qa-private-key');expect(messages).not.toContain('private-personal-gateway');
  const tools=call[2].tools!;expect(JSON.stringify(tools.definitions)).not.toContain('read_node_doc');
  expect(await tools.execute('secret_get',{})).toMatchObject({catalogueUnchanged:true});
  expect(await tools.execute('catalog_apply',{})).toMatchObject({catalogueUnchanged:true});
  await tools.execute('catalog_read',{url});call[2].onDelta(JSON.stringify(proposal));call[2].onDone();
  expect(success).toHaveBeenCalledOnce();expect(failure).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['model_catalog_web_read']);
});
it('tool-round preambles do not contaminate the final JSON proposal',async()=>{
  vi.mocked(invoke).mockResolvedValue('<html><body>'+quote+'</body></html>');const success=vi.fn();const fail=vi.fn();
  startCatalogAssistant({...DEFAULT_AI_SETTINGS,apiKey:'synthetic'},'更新',vi.fn(),success,fail);
  const handlers=vi.mocked(streamChatAgentic).mock.calls[0][2];handlers.onDelta('我先查询官方资料。');await handlers.tools!.execute('catalog_read',{url});handlers.onRoundStart!();handlers.onDelta(JSON.stringify(proposal));handlers.onDone();expect(success).toHaveBeenCalledOnce();expect(fail).not.toHaveBeenCalled();
});
it('an upsert preserves unmentioned transport fields and old provider URL aliases',async()=>{
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{},dispatchEvent:vi.fn()});vi.mocked(invoke).mockResolvedValue({revision:0,providers:[],canRollback:false});await loadCatalogue();
  const data=structuredClone(proposal);data.providers[0]={...data.providers[0],id:'openai',name:'OpenAI',baseUrl:'https://api-new.example.com/v1',models:[{id:'gpt-6-luna',window:1050000,output:128000,omitTemperature:false,reasoning:{kind:'effort',levels:['none'],default:'none'}}]};
  vi.mocked(invoke).mockImplementation(async(_command,args)=>({revision:1,providers:(args as {providers:unknown[]}).providers,canRollback:true}));
  await applyCatalogue(validateProposal(JSON.stringify(data),[{url,text:quote}]),0);
  const saved=getProviderPresets().find(p=>p.id==='openai')!;expect(saved.models.find(m=>m.id==='gpt-6-luna')?.extra).toEqual({reasoning_effort:'none'});expect(saved.aliases).toContain('https://api.openai.com/v1');
});
it('connection test sends exactly one short synthetic request and never saves configuration',async()=>{
  vi.mocked(invoke).mockResolvedValue({ok:true,stage:'model',status:200,elapsedMs:25,message:'合成模型已响应'});
  const before=JSON.stringify(storage);
  await testConnection({...DEFAULT_AI_SETTINGS,baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'synthetic-key',maxTokens:393216,reasoningEffort:'max'});
  expect(invoke).toHaveBeenCalledOnce();const [command,request]=vi.mocked(invoke).mock.calls[0];expect(command).toBe('ai_connection_test');
  const args=request as {body:string;headers:Record<string,string>};const body=JSON.parse(args.body);
  expect(body.messages).toEqual([{role:'user',content:'Reply with OK.'}]);expect(body.max_tokens).toBe(1024);expect(body.stream).toBe(false);expect(body.tools).toBeUndefined();expect(args.body).not.toContain('synthetic-key');expect(args.headers.Authorization).toBe('Bearer synthetic-key');expect(JSON.stringify(storage)).toBe(before);
});
it('HTML is only source text; scripts and untrusted navigation instructions are not executed',()=>{
  expect(pageText('<html><body><script>stealKey()</script><p>context 1048576</p></body></html>')).not.toContain('stealKey');
});
