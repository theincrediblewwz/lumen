// Actual node/chat/settings/reader/backup components; no real provider or private data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,webkit}=require(process.env.LSQ_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.LSQ_UI_URL||'http://127.0.0.1:5198',output=process.env.LSQ_UI_EVIDENCE||'output/playwright';fs.mkdirSync(output,{recursive:true});
let browser,page;const errors=[],checks=[];
const url=(mode,extra='')=>`${base}/scripts/knowledge-ui-fixture.html?platform=macos&mode=${mode}&project=project&board=board&name=合成节点&captureQA=1&nodes=1&operationsQA=1${extra}`;
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('lumen.fixture-capture')));
async function shot(name){await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});}
async function click(locator){await locator.scrollIntoViewIfNeeded();await locator.click();}
async function ready(){await page.evaluate(async()=>{const e=await import('/src/sync/events.ts');e.registerEditorFlush(async()=>{});e.registerLibraryRefresh(async()=>{});});}
async function select(id){const msg=page.locator(`[data-message-id="${id}"]`);if(!await msg.locator('.ai-message-tools').evaluate(el=>el.open))await click(msg.locator('.ai-message-tools>summary'));await msg.getByRole('checkbox').check();}
async function waitSaved(){await page.waitForFunction(()=>!document.querySelector('button[aria-label="新对话"]').disabled);}
(async()=>{
 const engine=process.env.LSQ_UI_BROWSER||'chromium';browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.LSQ_UI_CHANNEL?{channel:process.env.LSQ_UI_CHANNEL}:{})});const context=await browser.newContext({viewport:{width:1180,height:820}});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(url('ai'));await page.locator('.ai-msg').first().waitFor();
 await page.evaluate(()=>{const now='2026-10-22T10:00:00Z';const node={id:'synthetic-node',title:'我的问题',summary:'当前讨论的节点',x:100,y:160,w:240,docs:[{path:'docs/original.md',title:'原始材料'}],created_at:now,updated_at:now};const board={version:1,id:'board',projectId:'project',name:'合成学习白板',nodes:[node],edges:[],viewport:{x:0,y:0,zoom:1},created_at:now,updated_at:now};const messages=[{id:'q_a',role:'user',content:'问题A',at:now},{id:'a_a',role:'assistant',content:'回答A。字段 x_1 保留文本。\n\n公式 $x_i^2$。\n\n$$\\frac{1}{2}$$',at:now},{id:'q_b',role:'user',content:'问题B',at:now},{id:'a_b',role:'assistant',content:'回答B，不应误打开A。',at:now}];localStorage.setItem('lumen.fixture-capture',JSON.stringify({documents:{'docs/original.md':'# 原始材料\n\n当前节点原文 $E=mc^2$。'},boards:{board},chats:{version:1,conversations:[{id:'c_node_a',sourceNodeId:'synthetic-node',title:'节点A历史',createdAt:now,updatedAt:now,messages},{id:'c_other_node',sourceNodeId:'other-node',title:'其他节点的对话',createdAt:now,updatedAt:now,messages:[{id:'q_other',role:'user',content:'其他节点问题',at:now}]}]}}));});
 await page.goto(url('main'));await page.locator('.project-tile.is-project').filter({hasText:'桌面夹'}).dblclick();await page.locator('.project-tile.is-board').filter({hasText:'合成学习白板'}).click();await page.locator('.node-card').click();await page.getByRole('button',{name:'与 AI 对话',exact:true}).filter({has:page.locator('svg')}).first().click();await page.waitForFunction(()=>window.__fixtureWindowOptions.some(w=>w.url.includes('node=synthetic-node')));const native=await page.evaluate(()=>window.__fixtureWindowOptions.find(w=>w.url.includes('node=synthetic-node')));await shot('node-01-panel-entry');
 checks.push('actual node panel opens a node-scoped native AI window with explicit node identity');
 await page.goto(url('ai','&node=synthetic-node'));await page.locator('[data-message-id="q_a"]').waitFor();await ready();await page.locator('.ai-scope').filter({hasText:'我的问题'}).waitFor();await page.getByRole('button',{name:'历史对话',exact:true}).click();assert.equal(await page.getByText('其他节点的对话',{exact:true}).count(),0);await page.getByRole('button',{name:'历史对话',exact:true}).click();
 await select('q_a');await click(page.locator('.ai-selection-actions').getByRole('button',{name:'保存为节点',exact:true}));await page.getByRole('button',{name:'打开已保存笔记'}).waitFor();await waitSaved();assert.equal(await page.evaluate(()=>window.__fixtureCaptureCalls.at(-1).parentId),'synthetic-node');assert.ok((await state()).boards.board.edges.some(e=>e.from==='synthetic-node'));
 checks.push('node history is scoped; saving a complete turn defaults to a directed child of the source node');
 await click(page.locator('.ai-conversation-tools>summary'));assert.equal(await page.getByRole('combobox',{name:'文档保存到'}).inputValue(),'synthetic-node');
 await select('q_a');await click(page.getByRole('button',{name:'存为节点文档',exact:true}));await page.getByText('已存为节点文档，原有文档已保留。',{exact:true}).waitFor();await waitSaved();const first=await page.evaluate(()=>window.__fixtureOperationCalls.at(-1));const firstPath=(await state()).boards.board.nodes[0].docs.slice(-1)[0].path;const firstBody=(await state()).documents[firstPath];assert.ok(firstBody.includes('回答A'));assert.equal((await state()).documents['docs/original.md'],'# 原始材料\n\n当前节点原文 $E=mc^2$。');
 await select('q_b');await click(page.getByRole('button',{name:'存为节点文档',exact:true}));await waitSaved();await select('q_a');await click(page.getByRole('button',{name:'存为节点文档',exact:true}));await waitSaved();await click(page.getByRole('button',{name:'打开已保存笔记'}));await page.waitForFunction(()=>window.__fixtureWindowOptions.some(w=>w.url.includes('reader=1')));const reader=await page.evaluate(()=>window.__fixtureWindowOptions.filter(w=>w.url.includes('reader=1')).slice(-1)[0].url);assert.equal(new URL(reader,'https://synthetic.invalid').searchParams.get('path'),firstPath);
 checks.push('save-as-document appends original complete Markdown to an existing node, preserves source chat/original documents, and duplicate A after B opens A');
 await page.goto(url('reader','&'+reader.split('?')[1]));await page.waitForFunction(()=>document.querySelectorAll('.reader-content .katex').length>=2);assert.ok((await page.locator('.reader-content').innerText()).includes('字段 x_1'));await page.getByRole('button',{name:'导出 Markdown',exact:true}).click();await page.getByText(/已导出：/).waitFor();assert.equal(await page.evaluate(()=>window.__fixtureExports.at(-1).content),firstBody);await shot('node-02-document-export-math');
 checks.push('reader renders explicit formulas and literal identifiers consistently; Markdown export preserves every source byte through the native command arguments');
 await page.goto(url('main'));await page.locator('.project-tile.is-project').filter({hasText:'桌面夹'}).dblclick();await page.locator('.project-tile.is-board').filter({hasText:'合成学习白板'}).click();await page.getByRole('button',{name:'整理布局',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.arrange-progress'));await page.locator('.node-card').first().click();await page.waitForFunction(()=>document.querySelectorAll('.doc-card .katex').length>=3);assert.ok(await page.getByRole('button',{name:/导出 Markdown：/}).count()>=3);await click(page.getByRole('button',{name:/导出 Markdown：/}).first());await page.waitForFunction(()=>window.__fixtureExports.length===1);await shot('node-03-preview-export');
 checks.push('node preview cards render full explicit formulas and expose a direct document export action');
 await page.goto(url('ai','&node=synthetic-node'));await page.locator('.ai-scope').waitFor();await ready();await page.getByRole('button',{name:'设置',exact:true}).click();const permission=page.getByRole('switch',{name:'允许 AI 修改白板'});assert.equal(await permission.getAttribute('aria-checked'),'false');await permission.click();await page.getByRole('button',{name:'知情并开启'}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lumen.fixture-board-policy')).enabled);await page.getByLabel('每个白板保留版本').fill('3');await page.getByRole('button',{name:'保存份数'}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lumen.fixture-board-policy')).keep===3);await shot('node-04-permission-settings');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByLabel('输入问题',{exact:true}).fill('请围绕这个节点建一个方向');await page.getByLabel('输入问题',{exact:true}).press('Enter');await page.getByText('已完成整理。公式',{exact:false}).waitFor();await waitSaved();const requests=await page.evaluate(()=>window.__fixtureCatalogRequests);assert.ok(requests[0].messages[0].content.includes('当前讨论节点'));assert.ok(requests[0].messages[0].content.includes('docIndex=0'));assert.equal(requests[0].messages[0].content.includes('当前节点原文'),false);assert.ok(requests[0].tools.some(t=>t.function.name==='apply_board_operations'));assert.equal((await state()).boards.board.nodes.filter(n=>n.title==='AI 生成的方向').length,1);assert.equal((await page.locator('.ai-messages').innerText()).includes('lumen.board-operations/v1'),false);await shot('node-05-ai-operation-result');
 checks.push('informed device permission persists; actual agent tool stream includes node identity and document metadata without an automatic document body, writes a node, and renders normal prose plus a receipt without tool JSON');
 const beforeRevoked=(await state()).boards.board.nodes.length;await page.evaluate(()=>{window.__fixtureRevokeBeforeApply=true;});await page.getByLabel('输入问题',{exact:true}).fill('合成撤权检查');await page.getByLabel('输入问题',{exact:true}).press('Enter');await waitSaved();await page.getByText(/授权已撤销，本批未写入/).waitFor();assert.equal((await state()).boards.board.nodes.length,beforeRevoked);await page.evaluate(()=>{window.__fixtureRevokeBeforeApply=false;});
 checks.push('revocation after request preparation but before the returned tool executes rejects the late batch without graph changes');
 // Reload to get the revoked policy, then enable again for an in-flight commit/cancel check.
 await page.goto(url('ai','&node=synthetic-node'));await page.locator('.ai-scope').waitFor();await ready();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('switch',{name:'允许 AI 修改白板'}).click();await page.getByRole('button',{name:'知情并开启'}).click();await page.getByRole('button',{name:'取消',exact:true}).click();await page.evaluate(()=>{window.__fixtureOperationDelay=1500;});await page.getByLabel('输入问题',{exact:true}).fill('合成迟到操作');await page.getByLabel('输入问题',{exact:true}).press('Enter');await page.getByText('整理白板并保存版本',{exact:false}).waitFor();await page.waitForFunction(()=>window.__fixtureOperationStarted);await page.getByRole('button',{name:'停止',exact:true}).click();assert.equal(await page.getByLabel('输入问题',{exact:true}).isDisabled(),true);await waitSaved();await page.evaluate(()=>{window.__fixtureOperationDelay=0;});const createdAfterCancel=(await state()).boards.board.nodes.filter(n=>n.title==='AI 生成的方向').length;
 checks.push('cancelling an in-flight local commit keeps send/navigation locked until its receipt arrives, preventing old callbacks from entering a later answer');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('每个白板保留版本').fill('');await permission.click();await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('lumen.fixture-board-policy')).enabled);await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByLabel('输入问题',{exact:true}).fill('未授权时再建节点');await page.getByLabel('输入问题',{exact:true}).press('Enter');await page.getByText('当前只读，尚未获得修改授权。',{exact:true}).waitFor();assert.equal((await state()).boards.board.nodes.filter(n=>n.title==='AI 生成的方向').length,createdAfterCancel);
 checks.push('revocation succeeds even with an invalid retention draft; later sends omit write capability and cannot modify the board');
 for(const theme of ['light','paper','dark']){await page.evaluate(async theme=>{const{applySettings,DEFAULT_SETTINGS}=await import('/src/settings.ts');applySettings({...DEFAULT_SETTINGS,theme,glass:false},'macos');},theme);await page.setViewportSize({width:520,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await shot('node-06-'+theme);}
 checks.push('new node scope, document controls and AI receipts remain within the viewport in all three themes');
 await page.setViewportSize({width:1180,height:820});await page.goto(url('main'));await page.locator('.project-tile.is-project').filter({hasText:'桌面夹'}).dblclick();await page.locator('.project-tile.is-board').filter({hasText:'合成学习白板'}).click();await page.getByRole('button',{name:'菜单',exact:true}).click();await page.getByText('快照与恢复…',{exact:true}).click();await page.getByRole('button',{name:'恢复此版本',exact:true}).first().waitFor();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'恢复此版本',exact:true}).first().click();await page.getByText('已恢复，恢复前版本也已保存。',{exact:true}).waitFor();assert.equal((await state()).boards.board.nodes.filter(n=>n.title==='AI 生成的方向').length,createdAfterCancel-1);await shot('node-07-version-restore');
 checks.push('the real board menu exposes document-inclusive versions; restoring a pre-operation version removes its graph changes while source chat remains available');
 const layoutBefore = await page.evaluate(() => {
  const seed=JSON.parse(localStorage.getItem('lumen.fixture-capture')), board=seed.boards.board;
  const at='2026-11-26T00:00:00Z';
  const card=(id,title,x,y)=>({id,title,x,y,w:200,h:120,docs:[],created_at:at,updated_at:at});
  const groups=['第一组','第二组','第三组'];
  board.nodes=[card('untouched','保留原位',-900,30)];
  board.edges=[];
  for (let g=0;g<groups.length;g++) {
   const id='row-'+g, x=100+1700*g;
   board.nodes.push(card(id,groups[g],x,100));
   for(let i=0;i<6;i++){
    const child=id+'-'+i;
    board.nodes.push(card(child,'内容 '+(i+1),x+245*i,330));
    board.edges.push({id:'e-'+child,from:id,to:child,directed:true,label:null,created_at:at});
   }
  }
  board.nodes.find(n=>n.id==='row-0').flow={nodeIds:['protected-step']};
  board.nodes.push({...card('protected-step','原流程步骤',0,0),flowOwnerId:'row-0'});
  localStorage.setItem('lumen.fixture-board-policy',JSON.stringify({enabled:true,revision:10,keep:20}));
  localStorage.setItem('lumen.fixture-capture',JSON.stringify(seed));
  return board;
 });
 await page.goto(url('ai','&presentationQA=1'));await ready();
 await page.evaluate(() => {
  window.__fixturePresentationPlan=[
   [{type:'update_node_presentation',nodeId:'row-1',position:{x:1900,y:200},color:'#34885f',includeDescendants:true}],
   [{type:'arrange_nodes',selection:{kind:'branches',rootIds:['row-0','row-1','row-2'],stack:true},direction:'auto',spacing:'compact'}]
  ];
 });
 const question=page.getByLabel('输入问题',{exact:true});
 await question.fill('把三棵分支分成上中下三行，第二组标绿色');
 await question.press('Enter');
 await page.getByText('分支已排好，颜色已保存。',{exact:true}).waitFor();
 await page.getByText(/已调整 21 个节点的位置/).first().waitFor();
 const layoutCalls=await page.evaluate(()=>window.__fixtureOperationCalls);
 assert.equal(layoutCalls.length,2);
 const measured=layoutCalls[1].batch.operations[0];
 assert.equal(measured.type,'place_measured_nodes');
 const after=(await state()).boards.board;
 const byId=new Map(after.nodes.map(node=>[node.id,node]));
 for(const id of ['untouched','protected-step'])assert.deepEqual(byId.get(id),layoutBefore.nodes.find(node=>node.id===id));
 assert.deepEqual(after.edges,layoutBefore.edges);
 assert.equal(byId.get('row-1-3').color,'#34885f');
 assert.ok(byId.get('row-0').y<byId.get('row-1').y&&byId.get('row-1').y<byId.get('row-2').y);
 for(let row=0;row<3;row++){
  assert.equal(byId.get('row-'+row+'-0').y,byId.get('row-'+row+'-5').y);
  assert.equal(byId.get('row-'+row).w,200);
 }
 await page.goto(url('main','&presentationQA=1'));
 await page.locator('.project-tile.is-project').filter({hasText:'桌面夹'}).dblclick();
 await page.locator('.project-tile.is-board').filter({hasText:'合成学习白板'}).click();
 await page.getByRole('button',{name:'适配全部内容到屏幕',exact:true}).click();
 await page.locator('[data-node-id="row-2"]').waitFor();
 await shot('node-08-adaptive-layout');
 checks.push('ordinary AI chat uses measured geometry to stack three wide branches with color, leaving unselected cards, flow steps, and relationships intact');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'node-operations-qa.json'),JSON.stringify({checks,errors,realProviderCalls:0,realCredentialsRead:0,nativeFilesystemVerifiedSeparately:true},null,2));await browser.close();console.log(JSON.stringify({pass:true,checks:checks.length,output}));
})().catch(async error=>{if(page){await shot('node-operation-failure').catch(()=>{});fs.writeFileSync(path.join(output,'node-operation-failure.txt'),await page.locator('body').ariaSnapshot().catch(()=>''));}if(browser)await browser.close();console.error(error);process.exitCode=1;});
