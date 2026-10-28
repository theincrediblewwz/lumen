import { expect, it } from 'vitest';
import { PROVIDER_PRESETS, PROTOCOL_RESERVE, modelLimits, recommendedModel, reasoningFields, modelPreset, providerFor,setCatalogProviders } from './modelCatalog';
import { buildChatRequest, accumulateReasoningDetails, parseSseChunkRich } from './provider';
import { estimateTokens } from './boardContext';

it('independent ceilings share the window according to actual request input', () => {
  for (const provider of PROVIDER_PRESETS) for (const model of provider.models) {
    const recommendation = recommendedModel(model.id,provider.baseUrl);
    expect(recommendation.contextBudget).toBeGreaterThan(900_000);
    const manual = modelLimits(model.id, Number.MAX_SAFE_INTEGER,provider.baseUrl);
    expect(manual.maxInput).toBeGreaterThanOrEqual(1000);
    expect(manual.output).toBeLessThanOrEqual(model.output);
    expect(manual.maxInput + PROTOCOL_RESERVE).toBeLessThan(model.window);
    const messages=[{role:'user' as const,content:'合成资料'.repeat(80)}];
    const body=JSON.parse(buildChatRequest({kind:'openai',baseUrl:provider.baseUrl,apiKey:'synthetic',...recommendation},messages).body);
    expect((body.max_tokens??body.max_completion_tokens)+estimateTokens(JSON.stringify(messages))+PROTOCOL_RESERVE).toBeLessThanOrEqual(model.window);
    expect(new URL(provider.docs).protocol).toBe('https:');
  }
});
it('custom models have a clearly separate bounded application policy', () => {
  const limits = modelLimits('private-custom-model', 9999999);
  expect(limits.known).toBe(false);
  expect(limits.output).toBe(393216);
  expect(limits.window).toBe(1048576);
});
it('Qwen thinking input stays within its separate official cap when output is reduced', () => {
  for (const model of ['qwen3.8-max', 'qwen3.8-flash']) {
    expect(modelLimits(model, 1).maxInput).toBe(983616);
    expect(modelLimits(model, 131072).maxInput).toBe(983616);
  }
});
it('a near-million-token input reaches the request and reduces output instead of truncating input',()=>{
  const messages=[{role:'user' as const,content:'文'.repeat(1_020_000)}];
  const spec=buildChatRequest({kind:'openai',apiKey:'synthetic',baseUrl:'https://api.deepseek.com',...recommendedModel('deepseek-flash','https://api.deepseek.com')},messages);
  const body=JSON.parse(spec.body);
  expect(body.messages[0].content.length).toBe(1_020_000);
  expect(body.max_tokens).toBeGreaterThan(20_000);expect(body.max_tokens).toBeLessThan(30_000);
});
it('native reasoning levels map to real protocols without invented levels',()=>{
  expect(reasoningFields(modelPreset('deepseek-flash'),'max')).toEqual({thinking:{type:'enabled'},reasoning_effort:'max'});
  expect(reasoningFields(modelPreset('mimo-v2.6-pro'),'none')).toEqual({thinking:{type:'disabled'}});
  expect(()=>reasoningFields(modelPreset('mimo-v2.6-pro'),'max')).toThrow('档位');
  expect(reasoningFields(modelPreset('qwen3.8-max'),'xhigh')).toEqual({enable_thinking:true,reasoning_effort:'xhigh'});
  expect(reasoningFields(modelPreset('qwen3.8-max'),'none')).toEqual({enable_thinking:false});
  expect(reasoningFields(modelPreset('glm-5.3'),'low')).toEqual({reasoning_effort:'low'});
  expect(()=>reasoningFields(modelPreset('kimi-k3'),'none')).toThrow('档位');
});
it('gateway aliases and current OpenCode production paths are scoped',()=>{
  expect(providerFor('https://opencode.ai/inference/go/openai/v1')?.id).toBe('opencode-go');
  expect(providerFor('https://opencode.ai/inference/openai/v1')?.id).toBe('opencode');
  const gateway=modelPreset('deepseek/deepseek-v4.1-flash','https://openrouter.ai/api/v1')!;
  expect(gateway.output).toBe(943718);
  const spec=buildChatRequest({kind:'openai',apiKey:'synthetic',baseUrl:'https://openrouter.ai/api/v1',model:gateway.id,reasoningEffort:'max'},[]);
  const body=JSON.parse(spec.body);expect(body.reasoning).toEqual({effort:'max'});expect(body.reasoning_effort).toBeUndefined();
  const go=buildChatRequest({kind:'openai',apiKey:'synthetic',baseUrl:'https://opencode.ai/inference/go/openai/v1',model:'deepseek-v4.1-flash',sessionId:'stable-test-session'},[]);
  expect(go.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
  expect(go.headers['x-opencode-session']).toBe('stable-test-session');expect(go.headers['User-Agent']).toContain('Lumen');
});
it('recognizes official legacy gateway paths even under a saved catalogue without altering request addresses or keys',()=>{
 const original=PROVIDER_PRESETS.find(p=>p.id==='opencode-go')!;try{setCatalogProviders([{...original,aliases:undefined}]);for(const url of ['https://opencode.ai/inference/go/openai/v1','https://opencode.ai/zen/go/v1']){const request={kind:'openai' as const,baseUrl:url,apiKey:'fixture-key-1',model:'deepseek-v4.1-flash',maxTokens:131072,reasoningEffort:'none'};const spec=buildChatRequest(request,[]);expect(spec.url).toBe(url+'/chat/completions');expect(spec.headers.Authorization).toBe('Bearer fixture-key-1');expect(JSON.parse(spec.body)).toMatchObject({model:request.model,max_tokens:131072,thinking:{type:'disabled'}});expect(request.baseUrl).toBe(url);}expect(modelPreset('deepseek-v4.1-flash','https://unknown.invalid/v1')).toBeUndefined();expect(providerFor('https://opencode.ai/zen/v1')?.id).toBe('opencode');}finally{setCatalogProviders([]);}
});
it('gateway reasoning aliases and signed fragments survive tool continuation',()=>{
  const response='data: '+JSON.stringify({choices:[{delta:{reasoning:'synthetic-thought',reasoning_details:[{index:0,type:'reasoning.encrypted',data:'abc',signature:'sig'}]}}]})+'\n\n';
  const parsed=parseSseChunkRich(response);expect(parsed.reasoningDeltas).toEqual(['synthetic-thought']);
  expect(accumulateReasoningDetails([...parsed.reasoningDetails,{index:0,type:'reasoning.encrypted',data:'def',signature:'nature'}])).toEqual([{index:0,type:'reasoning.encrypted',data:'abcdef',signature:'signature'}]);
});
