// Real settings/components, synthetic public documents, credentials and model stream only.
const {createRequire}=require('node:module');
const {mkdirSync,writeFileSync}=require('node:fs');
const path=require('node:path');const assert=require('node:assert/strict');
const {chromium,webkit}=createRequire(__filename)(process.env.LSQ_PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.env.LSQ_UI_EVIDENCE||'mac-ui-evidence');mkdirSync(output,{recursive:true});
const base=process.env.LSQ_UI_URL||'http://127.0.0.1:5198';const checks=[],errors=[];let browser,page;
const storage=page=>page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('lumen.ai.'))));
async function shot(name){await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});}
async function click(locator){await locator.scrollIntoViewIfNeeded();await locator.click();}
async function settings(){await click(page.getByRole('button',{name:'设置',exact:true}));await page.getByRole('form',{name:'AI 设置',exact:true}).waitFor();}
(async()=>{
 const engine=process.env.LSQ_UI_BROWSER||'chromium';browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.LSQ_UI_CHANNEL?{channel:process.env.LSQ_UI_CHANNEL}:{})});
 const context=await browser.newContext({viewport:{width:1040,height:720}});page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const fixture=`${base}/scripts/knowledge-ui-fixture.html?mode=ai&platform=macos&project=project&board=board&name=Mac学习白板&catalogQA=1`;
 await page.goto(fixture);await page.locator('.ai-root.is-mac').waitFor();
 await page.evaluate(async()=>{const{saveAiProfile,DEFAULT_AI_SETTINGS}=await import('/src/ai/aiSettings.ts');const{recommendedModel}=await import('/src/ai/modelCatalog.ts');await saveAiProfile({...DEFAULT_AI_SETTINGS,baseUrl:'https://api.deepseek.com',apiKey:'qa-key-A',...recommendedModel('deepseek-flash','https://api.deepseek.com')},'日常学习');await saveAiProfile({...DEFAULT_AI_SETTINGS,baseUrl:'https://api.xiaomimimo.com/v1',apiKey:'qa-key-B',shareBoard:false,...recommendedModel('mimo-v2.6-pro','https://api.xiaomimimo.com/v1')},'深入研究');});
 await page.reload();await page.locator('.ai-root.is-mac').waitFor();await settings();
 assert.equal(await page.getByRole('spinbutton',{name:/温度/}).count(),0);
 for(const [provider,levels] of [['deepseek',['none','low','high','max']],['mimo',['none','enabled']],['qwen',['none','low','medium','xhigh']],['kimi',['low','high','max']],['glm',['low','high','max']],['opencode-go',['none','low','high','max']],['openrouter',['none','low','high','max']]]){
  await page.getByLabel('供应商',{exact:true}).selectOption(provider);assert.deepEqual(await page.getByLabel('思考强度',{exact:true}).locator('option').evaluateAll(items=>items.map(i=>i.value)),levels);
 }
 assert.equal(await page.getByRole('spinbutton',{name:/最大输出/}).inputValue(),'943718');
 assert.equal(await page.getByRole('spinbutton',{name:/上下文预算/}).inputValue(),'1043456');
 checks.push('temperature removed; provider-specific native reasoning levels and exact million-class input/high output ceilings render');
 await page.getByLabel('API 地址',{exact:true}).fill('https://draft-gateway.invalid/v1');await page.getByLabel('API Key',{exact:true}).fill('qa-draft-key');
 const before=await storage(page);const secrets=await page.evaluate(()=>sessionStorage.getItem('lumen-fixture-secrets'));
 await click(page.getByRole('button',{name:'测试连接',exact:true}));await page.getByText(/所选合成模型已响应/).waitFor();
 const tests=await page.evaluate(()=>window.__fixtureTestRequests);assert.equal(tests.length,1);assert.deepEqual(tests[0].messages,[{role:'user',content:'Reply with OK.'}]);assert.equal(tests[0].stream,false);assert.equal(tests[0].tools,undefined);assert.ok(tests[0].max_tokens<=1024);
 checks.push('connection test uses unsaved draft without saving it; exactly one fixed short request with no board/history/tools');
 await click(page.locator('.ai-catalog-manager > summary'));await click(page.getByRole('button',{name:'AI 检查更新',exact:true}));
 await page.getByRole('region',{name:'目录更新预览'}).waitFor();
 assert.deepEqual(await storage(page),before);assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'qa-draft-key');
 assert.equal(await page.getByLabel('供应商',{exact:true}).locator('option[value=synthetic-next]').count(),0);
 const requests=JSON.stringify(await page.evaluate(()=>window.__fixtureCatalogRequests));assert.ok(!/qa-key-A|qa-key-B|qa-draft-key|draft-gateway/.test(requests));
 assert.ok(!requests.includes('read_node_doc'));assert.ok(!requests.includes('secret_get'));
 await click(page.locator('.ai-catalog-sources > summary'));await page.getByText('Model synthetic-next has a context window',{exact:false}).waitFor();
 await page.getByRole('heading',{name:'更新预览',exact:true}).scrollIntoViewIfNeeded();await shot('catalog-01-proposal-and-evidence');
 checks.push('AI uses public-only prompt and read tools; real source quote and diff appear; no update before explicit apply');
 await click(page.getByRole('button',{name:'应用目录更新',exact:true}));await page.getByText('公共目录已更新。你的连接、已选模型与 Key 保持原样。',{exact:true}).waitFor();
 assert.deepEqual(await storage(page),before);assert.equal(await page.evaluate(()=>sessionStorage.getItem('lumen-fixture-secrets')),secrets);
 assert.equal(await page.getByLabel('API 地址',{exact:true}).inputValue(),'https://draft-gateway.invalid/v1');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'qa-draft-key');
 assert.equal(await page.getByLabel('供应商',{exact:true}).locator('option[value=synthetic-next]').count(),1);
 checks.push('explicit apply adds new provider/model while every saved connection and credential, selected model and current draft stay unchanged');
 await page.reload();await page.locator('.ai-root.is-mac').waitFor();await settings();assert.equal(await page.getByLabel('供应商',{exact:true}).locator('option[value=synthetic-next]').count(),1);
 await click(page.locator('.ai-catalog-manager > summary'));await click(page.getByRole('button',{name:'回退上一版',exact:true}));await page.getByText('已回退公共目录。你的连接与 Key 保持原样。',{exact:true}).waitFor();
 assert.deepEqual(await storage(page),before);assert.equal(await page.getByLabel('供应商',{exact:true}).locator('option[value=synthetic-next]').count(),0);
 checks.push('applied catalogue survives restart; previous catalogue can be restored without changing saved connections/keys');
 await click(page.locator('.ai-catalog-manager > summary'));
 for(const theme of ['light','paper','dark'])for(const [width,height]of [[1040,720],[380,600]]){
  await page.setViewportSize({width,height});await page.evaluate(async theme=>{const{DEFAULT_SETTINGS,applySettings}=await import('/src/settings.ts');applySettings({...DEFAULT_SETTINGS,theme,glass:false},'macos');document.querySelector('.ai-settings-scroll').scrollTop=0;},theme);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot(`catalog-02-settings-${theme}-${width}`);
  const save=await page.getByRole('button',{name:'保存',exact:true}).boundingBox();assert.ok(save&&save.y+save.height<=height+1);
 }
 checks.push('three themes and wide/narrow settings keep readable controls, no horizontal overflow and visible save/cancel');
 await page.goto(fixture+'&testFailure=1');await page.locator('.ai-root.is-mac').waitFor();await settings();await click(page.getByRole('button',{name:'测试连接',exact:true}));await page.getByText(/接口可达，鉴权未通过/).waitFor();assert.deepEqual(await storage(page),before);await shot('catalog-03-auth-failure');
 checks.push('authentication failure is distinct from model response and does not expose credentials or save the form');
 assert.deepEqual(errors,[]);const result={environment:`${process.platform}, ${engine}, actual components and synthetic native bridge`,checks,errors,realProviderCalls:0,nativeTauriUI:false};writeFileSync(path.join(output,'model-catalog-qa.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 await browser.close();
})().catch(async e=>{if(page)await page.screenshot({path:path.join(output,'catalog-failure.png')}).catch(()=>{});if(browser)await browser.close();console.error(e.stack||e);process.exit(1);});
