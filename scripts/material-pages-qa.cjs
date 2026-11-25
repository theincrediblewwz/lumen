// Actual App, synthetic documents/images only. Browser plugin not available: project WebKit fallback.
const {webkit}=require(process.env.LSQ_PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.LSQ_UI_URL||'http://127.0.0.1:5198',out=path.resolve(process.env.LSQ_UI_EVIDENCE||'mac-ui-evidence');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await webkit.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:960}}),checks=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text());});
 const check=s=>{checks.push(s);console.log(s);},card=id=>page.locator(`.canvas-world>[data-node-id="${id}"]`),state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('lumen.fixture-capture')));
 const fit=async()=>{await page.getByRole('button',{name:'适配全部内容到屏幕',exact:true}).click();await page.waitForTimeout(260);};
 const preview=()=>card('materials').locator('.node-preview');
 const turnMaterial = async button => {
   await button.locator('..').hover();
   await button.click();
 };
 try{
  await page.goto(base+'/scripts/knowledge-ui-fixture.html?mode=main&platform=macos&captureQA',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__fixtureReactMounted);
  await page.evaluate(async()=>{
   const image=async(w,h,label)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.fillStyle='#19583c';x.font=`${Math.max(16,w/30)}px serif`;x.fillText(label,20,80);return window.__TAURI_INTERNALS__.invoke('image_document',{projectId:'project',boardId:'board',expectedScope:'synthetic-scope',base64Data:c.toDataURL().split(',')[1]});};
   const small=await image(320,160,'SMALL'),large=await image(2400,1200,'HIGH RESOLUTION'),portrait=await image(600,1200,'PORTRAIT');
   const s=JSON.parse(localStorage.getItem('lumen.fixture-capture')),at='2026-11-18';
   const text=Array.from({length:45},(_,i)=>`段落${i}：完整保留的分页文字。`+'每一页都能清晰阅读，公式也要完整显示。'.repeat(4)).join('\n\n')+'\n\n$$\\frac{1}{2} + \\nu = x^2$$\n\n```js\nconst final_value = 42;\n```\n\nEND_OF_DOCUMENT';
   s.documents['docs/pages.md']=text;s.documents['docs/short.md']='# 下一个文档\n\nSECOND_DOCUMENT';
   const doc={path:'docs/pages.md',title:'分页文档',bytes:text.length},short={path:'docs/short.md',title:'下一篇文档',bytes:42};
   const node=(id,title,x,y,extra={})=>({id,title,x,y,w:420,docs:[],created_at:at,updated_at:at,...extra});
   s.boards.board={version:1,id:'board',projectId:'project',name:'分页与子流程',created_at:at,updated_at:at,viewport:{x:0,y:0,zoom:1},nodes:[node('materials','多素材节点',80,140,{docs:[doc,small,large,short,portrait]}),node('owner','技术流程',1750,140,{color:'#3a9d5d',docs:[short],flow:{nodeIds:['step-a','step-b','step-c']}}),node('step-a','步骤 A',0,0,{flowOwnerId:'owner',docs:[doc]}),node('step-b','步骤 B',0,0,{flowOwnerId:'owner',docs:[large]}),node('step-c','步骤 C',0,0,{flowOwnerId:'owner',summary:'流程第三步的说明。'})],edges:[{id:'main',from:'materials',to:'owner',directed:true,created_at:at},{id:'ab',from:'step-a',to:'step-b',directed:true,created_at:at},{id:'bc',from:'step-b',to:'step-c',directed:true,created_at:at}]};
   localStorage.setItem('lumen.fixture-capture',JSON.stringify(s));
  });
  const syntheticAssets=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('lumen.fixture-assets')||'{}'));for(const [name,bytes]of Object.entries(syntheticAssets))fs.writeFileSync(path.join(out,path.basename(name)),Buffer.from(bytes));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__fixtureReactMounted);await page.getByText('桌面夹',{exact:true}).dblclick();await page.getByText('分页与子流程',{exact:true}).click();
  assert.match(await page.title(),/知识库合成页面验收/);assert.equal(await page.locator('vite-error-overlay').count(),0);await card('materials').locator('[data-content-status="ready"]').first().waitFor();
  await page.waitForFunction(()=>Number(document.querySelector('[data-node-id="materials"] .node-preview').dataset.previewPages)>1);await page.waitForFunction(()=>!document.querySelector('[data-node-id="materials"] .math[data-tex]:not([data-done])'));
  await fit();const original=(await state()).boards.board.nodes;const count=Number(await preview().getAttribute('data-preview-pages'));assert.ok(count>3);
  const previous=()=>preview().getByRole('button',{name:'上一页',exact:true});
  const next=()=>preview().getByRole('button',{name:'下一页',exact:true});
  const previousMaterial=()=>preview().getByRole('button',{name:'上一个素材',exact:true});
  const nextMaterial=()=>preview().getByRole('button',{name:'下一个素材',exact:true});
  const progress=async (material,page,total)=>{
   assert.equal(await preview().locator('.node-preview-material-number').innerText(),String(material));
   assert.equal(await preview().locator('.node-preview-page-number').innerText(),`${page}/${total}`);
  };
  assert.equal(await preview().locator('.node-preview-previous').count(),0);
  await progress(1,1,count);
  await next().click();
  assert.equal(await preview().getAttribute('data-preview-page'),'1');
  const pagerStyle=button=>button.evaluate(e=>{const s=getComputedStyle(e);return {width:s.width,height:s.height,radius:s.borderRadius,bottom:s.bottom,left:s.left,right:s.right};});
  const left=await pagerStyle(previous()),right=await pagerStyle(next());
  assert.deepEqual([left.width,left.height,left.radius,left.bottom,left.left],['24px','24px','6px','4px','4px']);
  assert.deepEqual([right.width,right.height,right.radius,right.bottom,right.right],['24px','24px','6px','4px','4px']);
  const textViewport=await preview().locator('.node-page-viewport').boundingBox();
  for(const button of [previous(),next()])assert.ok((await button.boundingBox()).y>=textViewport.y+textViewport.height-.5);
  const indicator=await preview().locator('.node-preview-progress').boundingBox();
  assert.ok(indicator.y>=textViewport.y+textViewport.height-.5);
  assert.ok(Math.abs(indicator.x+indicator.width/2-(textViewport.x+textViewport.width/2))<1);
  await previous().focus();await previous().press('Enter');assert.equal(await preview().getAttribute('data-preview-page'),'0');
  assert.equal(await previous().count(),0);assert.equal(await next().evaluate(e=>document.activeElement===e),true);
  check('small rounded controls sit in opposite bottom corners; Previous appears after page one and returns keyboard focus on the first page');
  await page.locator('.board-settings-fab').click();const font=page.getByRole('slider',{name:'文档预览字号',exact:true});await font.focus();await font.press('End');await page.waitForFunction(previous=>Number(document.querySelector('[data-node-id="materials"] .node-preview').dataset.previewPages)>previous,count);await font.press('Home');for(let i=0;i<3;i++)await font.press('ArrowRight');await page.waitForFunction(previous=>Number(document.querySelector('[data-node-id="materials"] .node-preview').dataset.previewPages)===previous,count);await page.getByRole('button',{name:'关闭白板设置',exact:true}).click();check('font-size changes recalculate every page so later text remains reachable');
  assert.match(await preview().innerText(),/END_OF_DOCUMENT/);assert.equal(await preview().locator('.katex-error').count(),0);check('full Markdown beyond the old 1600-character limit renders as multiple pages with complete math and code');
  const seen=new Set();let end=false;
  for(let i=0;i<count;i++){
   assert.equal(Number(await preview().getAttribute('data-preview-page')),i);
   const visible=await preview().evaluate(e=>{const r=e.querySelector('.node-page-viewport').getBoundingClientRect();return [...e.querySelectorAll('p')].filter(p=>[...p.getClientRects()].some(b=>b.right>r.left+1&&b.left<r.right-1&&b.bottom>r.top&&b.top<r.bottom)).map(p=>p.textContent);});
   assert.ok(visible.length,`page ${i+1} contains visible document content`);
   visible.forEach(s=>{for(const m of s.matchAll(/段落(\d+)/g))seen.add(Number(m[1]));if(s.includes('END_OF_DOCUMENT'))end=true;});
   if(i<count-1)await preview().getByRole('button',{name:'下一页',exact:true}).click();
  }
  assert.equal(seen.size,45);assert.ok(end);check('walking every page visits all 45 paragraphs and the final marker without dropping content');
  assert.equal(await next().count(),0);
  assert.match(await nextMaterial().getAttribute('class'),/is-material-turn/);
  await progress(1,count,count);
  await page.screenshot({path:path.join(out,'material-pager-document-boundary.png')});
  await turnMaterial(nextMaterial());await card('materials').locator('.sticker-image').waitFor();await page.waitForFunction(()=>document.querySelector('[data-node-id="materials"] img')?.naturalWidth===320);await page.waitForTimeout(150);
  const small=await card('materials').boundingBox();assert.ok(small.width<430);check('the last document page advances to the next image in original attachment order');
  await progress(2,1,1);
  assert.equal(await previous().count(),0);
  assert.match(await previousMaterial().getAttribute('class'),/is-material-turn/);
  await turnMaterial(previousMaterial());await preview().locator('[data-content-status="ready"]').waitFor();
  assert.equal(await preview().getAttribute('data-preview-resource'),'docs/pages.md');
  assert.equal(await preview().getAttribute('data-preview-page'),String(count-1));
  await turnMaterial(nextMaterial());await card('materials').locator('.sticker-image').waitFor();
  check('Previous from an image returns to the last page of the preceding document');
  await turnMaterial(nextMaterial());await page.waitForFunction(()=>document.querySelector('[data-node-id="materials"] img')?.naturalWidth===2400);await page.waitForTimeout(150);const large=await card('materials').boundingBox();assert.ok(large.width>small.width*2);
  const ratio=await card('materials').locator('img').evaluate(e=>e.getBoundingClientRect().width/e.getBoundingClientRect().height);assert.ok(Math.abs(ratio-2)<.01);check('high-resolution next image grows proportionally instead of inheriting the smaller slide footprint');
  await fit();await turnMaterial(nextMaterial());await preview().locator('.node-document-opening[data-content-status="ready"]').waitFor();assert.match(await preview().innerText(),/SECOND_DOCUMENT/);check('image navigation continues to the next Markdown document');
  const shortPages=Number(await preview().getAttribute('data-preview-pages'));for(let i=0;i<shortPages-1;i++)await next().click();
  await turnMaterial(nextMaterial());await page.waitForFunction(()=>document.querySelector('[data-node-id="materials"] img')?.naturalHeight===1200);await fit();const portraitRatio=await card('materials').locator('img').evaluate(e=>e.getBoundingClientRect().width/e.getBoundingClientRect().height);assert.ok(Math.abs(portraitRatio-.5)<.01);
  await progress(5,1,1);
  assert.equal(await preview().locator('.node-preview-next').count(),0);
  assert.deepEqual((await state()).boards.board.nodes,original);
  check('single and double chevrons distinguish paging from switching materials, the counter follows both, and navigation stops at the end');
  await turnMaterial(previousMaterial());await preview().locator('[data-content-status="ready"]').first().waitFor();
  assert.equal(await preview().getAttribute('data-preview-resource'),'docs/short.md');
  assert.equal(await preview().getAttribute('data-preview-page'),String(shortPages-1));
  await fit();await card('owner').click();await page.locator('.flow-panel').waitFor();await page.locator('[data-flow-step="step-a"] [data-content-status="ready"]').first().waitFor();
  const before=await page.locator('.flow-panel').boundingBox(),handle=await page.getByRole('separator',{name:'调整子白板宽度',exact:true}).boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+180,handle.y+handle.height/2,{steps:10});await page.mouse.up();const after=await page.locator('.flow-panel').boundingBox();assert.ok(after.width>before.width+150);check('dragging the right border widens the subboard and reflows its steps');
  await page.locator('[data-flow-step="step-a"] .node-preview-next').click();assert.equal(await page.locator('[data-flow-step="step-a"] .node-preview').getAttribute('data-preview-page'),'1');
  const mother=await card('owner').boundingBox();await page.getByRole('button',{name:'收起全部步骤预览',exact:true}).click();assert.equal(await page.locator('.flow-panel .node-preview').count(),0);assert.equal(await page.locator('.flow-panel .node-title').count(),3);assert.ok(Math.abs((await card('owner').boundingBox()).height-mother.height)<1);assert.ok(await card('owner').locator('.node-preview').count());assert.deepEqual((await state()).boards.board.nodes,original);check('collapse shows only subflow titles and numbers without changing mother previews or stored nodes');
  await page.getByRole('button',{name:'展开全部步骤预览',exact:true}).click();await page.locator('.flow-panel .node-preview').first().waitFor();assert.equal(await page.locator('[data-flow-step="step-a"] .node-preview').getAttribute('data-preview-page'),'1');check('one click restores every subflow preview and its reading position');
  const mask=await page.locator('[data-flow-occlusion]').evaluate(e=>({x:Number(e.getAttribute('x')),y:Number(e.getAttribute('y')),w:Number(e.getAttribute('width')),h:Number(e.getAttribute('height'))}));const panel=await page.locator('.node-panel').boundingBox(),canvas=await page.locator('.board-canvas-live').boundingBox();assert.ok(Math.abs(mask.x-(panel.x-canvas.x-1))<2);assert.ok(mask.w>=panel.width);const stack=await page.evaluate(()=>[getComputedStyle(document.querySelector('.node-panel')).zIndex,getComputedStyle(document.querySelector('.flow-light-paths')).zIndex].map(Number));assert.ok(stack[0]>stack[1]);check('light paths exclude the current right panel rectangle and render beneath it');
  for(const theme of ['light','dark','paper']){await page.evaluate(async theme=>{const m=await import('/src/settings.ts');m.applySettings({...m.DEFAULT_SETTINGS,theme,glass:true},'macos');},theme);await page.screenshot({path:path.join(out,`material-flow-${theme}.png`)});}
  const glow=await card('owner').evaluate(e=>{const s=getComputedStyle(e,'::after');return{animation:s.animationName,border:s.borderTopWidth,shadow:s.boxShadow};});assert.equal(glow.animation,'flow-breathe');assert.ok(parseFloat(glow.border)>0);assert.notEqual(glow.shadow,'none');check('ordinary owner nodes have a bright hue-matched slow breathing perimeter');
  await page.locator('.flow-close').click();await page.locator('.np-close').click();await fit();await preview().waitFor();assert.equal(await preview().getAttribute('data-preview-resource'),'docs/short.md');assert.equal(await preview().getAttribute('data-preview-page'),String(shortPages-1));check('viewport virtualization restores the node reading position');await page.locator('.canvas-zoom-label').click();for(let i=0;i<6;i++)await page.keyboard.press('Meta+-');await page.locator('.heat-cell.has-flow').waitFor();const flowCount=await page.locator('.heat-cell').evaluateAll(c=>c.reduce((sum,e)=>sum+Number(e.dataset.flowCount),0));assert.equal(flowCount,1);assert.equal(await page.locator('.heat-cell.has-flow').evaluate(e=>getComputedStyle(e,'::after').animationName),'flow-breathe');check('overview aggregation retains the subflow marker and bright breathing perimeter');
  await page.screenshot({path:path.join(out,'material-overview.png')});
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.heat-cell.has-flow').evaluate(e=>getComputedStyle(e,'::after').animationName),'none');check('reduced-motion mode keeps a bright static perimeter');
  await page.setViewportSize({width:720,height:650});await page.locator('.canvas-zoom-label').click();await fit();if(await card('owner').count()){await card('owner').click();const b=await page.locator('.flow-panel').boundingBox();assert.ok(b.width<=688);await page.screenshot({path:path.join(out,'material-flow-720.png')});}check('subboard width remains bounded in a narrow viewport');
  // Load a real offline PDF and exercise its original pages, not extracted snippets.
  await page.setViewportSize({width:1440,height:960});await page.emulateMedia({reducedMotion:'no-preference'});
  const pdfBytes=[...fs.readFileSync(path.join(__dirname,'fixtures/rich-print.pdf'))];
  await page.evaluate(async bytes=>{const s=JSON.parse(localStorage.getItem('lumen.fixture-capture')),raw=new Uint8Array(bytes),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(v=>v.toString(16).padStart(2,'0')).join(''),asset={path:'docs/asset_'+hash+'.pdf',sha256:hash,size:raw.length,media_type:'application/pdf'};s.richDocuments['docs/preview.pdf']={markdown:'# PDF original',scope:'synthetic-scope',attachment:{schema:'lumen-document/v1',kind:'pdf',original:asset,images:{},pages:2,extraction:'ready'}};s.documents['docs/preview.pdf']='# PDF original';const assets=JSON.parse(sessionStorage.getItem('lumen.fixture-assets')||'{}');assets[asset.path]=bytes;sessionStorage.setItem('lumen.fixture-assets',JSON.stringify(assets));s.boards.board.nodes=[{id:'pdf',title:'PDF分页',x:100,y:130,w:420,docs:[{path:'docs/preview.pdf',title:'双页 PDF'}],created_at:'',updated_at:''}];s.boards.board.edges=[];s.boards.board.viewport={x:0,y:0,zoom:1};localStorage.setItem('lumen.fixture-capture',JSON.stringify(s));},pdfBytes);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__fixtureReactMounted);await page.getByText('桌面夹',{exact:true}).dblclick();await page.getByText('分页与子流程',{exact:true}).click();await card('pdf').locator('.node-pdf-page[data-content-status="ready"]').waitFor();assert.equal(await card('pdf').locator('.node-preview').getAttribute('data-preview-pages'),'2');
  const firstCanvas=await card('pdf').locator('canvas').evaluate(e=>e.toDataURL());await card('pdf').getByRole('button',{name:'下一页',exact:true}).click();await card('pdf').locator('canvas[aria-label="PDF 第2页"]').waitFor();await card('pdf').locator('.node-pdf-page[data-content-status="ready"]').waitFor();assert.notEqual(await card('pdf').locator('canvas').evaluate(e=>e.toDataURL()),firstCanvas);check('offline PDF previews render the distinct original first and second pages');
  await page.screenshot({path:path.join(out,'material-pdf.png')});
  // Promoting a document must still select it even when a full-question resource exists.
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('lumen.fixture-capture'));s.boards.board.nodes=[{id:'promote',title:'首位素材',summary:'完整问题仍然保留，公式 $\\nu$。',x:100,y:140,w:420,docs:[{path:'docs/question_promote.md',title:'完整问题'},{path:'docs/pages.md',title:'分页文档'},{path:'docs/short.md',title:'下一篇文档'}],created_at:'',updated_at:''}];localStorage.setItem('lumen.fixture-capture',JSON.stringify(s));});
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__fixtureReactMounted);await page.getByText('桌面夹',{exact:true}).dblclick();await page.getByText('分页与子流程',{exact:true}).click();
  const mixed=card('promote'),question=mixed.getByRole('group',{name:'完整问题预览'}),attachment=mixed.getByRole('group',{name:'附件预览'});
  await question.locator('[data-content-status="ready"]').waitFor();await attachment.locator('[data-content-status="ready"]').waitFor();
  assert.equal(await mixed.locator('.node-preview').count(),2);
  assert.match(await question.innerText(),/完整问题仍然保留/);
  assert.equal(await question.locator('.katex').count(),1);
  assert.equal(await attachment.getAttribute('data-preview-resource'),'docs/pages.md');
  assert.match(await attachment.innerText(),/段落0/);
  assert.equal(await mixed.getByRole('button',{name:'上一页',exact:true}).count(),0);
  await attachment.getByRole('button',{name:'下一页',exact:true}).click();
  assert.equal(await attachment.getAttribute('data-preview-page'),'1');
  assert.equal(await question.getAttribute('data-preview-page'),'0');
  await page.screenshot({path:path.join(out,'material-question-and-attachment.png')});
  check('title, question formula and the first attached Markdown are visible together while only the attachment turns');
  await mixed.click();await page.locator('.doc-card').last().hover();await page.getByRole('button',{name:'在白板预览：下一篇文档',exact:true}).click();
  await attachment.locator('[data-content-status="ready"]').waitFor();assert.equal(await attachment.getAttribute('data-preview-resource'),'docs/short.md');
  assert.match(await attachment.innerText(),/SECOND_DOCUMENT/);
  assert.equal((await state()).boards.board.nodes[0].summary,'完整问题仍然保留，公式 $\\nu$。');
  check('promoting an attachment selects it while the separate full-question document stays visible');await page.locator('.np-close').click();
  // A large Markdown resource remains completely accessible within bounded-height pages.
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('lumen.fixture-capture'));s.documents['docs/large.md']=Array.from({length:2400},(_,i)=>`段落 ${i} `+'大文档分页保持正文完整，翻页浏览而不是裁掉后半篇。'.repeat(6)).join('\n\n')+'\n\nLARGE_DOCUMENT_END';s.boards.board.nodes=[{id:'huge',title:'大文档分页',x:100,y:140,w:480,docs:[{path:'docs/large.md',title:'完整大文档'}],created_at:'',updated_at:''}];localStorage.setItem('lumen.fixture-capture',JSON.stringify(s));});
  const started=Date.now();await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__fixtureReactMounted);await page.getByText('桌面夹',{exact:true}).dblclick();await page.getByText('分页与子流程',{exact:true}).click();await card('huge').locator('[data-content-status="ready"]').waitFor();const hugePages=Number(await card('huge').locator('.node-preview').getAttribute('data-preview-pages'));assert.ok(hugePages>100);assert.ok((await card('huge').boundingBox()).height<400);assert.match(await card('huge').innerText(),/LARGE_DOCUMENT_END/);assert.equal(await card('huge').locator('.node-page-columns p').count(),2401);check('large Markdown retains every paragraph and its last marker while rendering a bounded-height first page');
  fs.writeFileSync(path.join(out,'material-large-metrics.json'),JSON.stringify({characters:(await state()).documents['docs/large.md'].length,bytes:Buffer.byteLength((await state()).documents['docs/large.md']),pages:hugePages,loadMs:Date.now()-started},null,2));

  await page.evaluate(async () => {
    const image = async (width, height, label) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f1f5f2'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#226c51'; ctx.font = `${width / 16}px sans-serif`; ctx.fillText(label, width / 18, height / 2);
      return window.__TAURI_INTERNALS__.invoke('image_document', { projectId: 'project', boardId: 'board', expectedScope: 'synthetic-scope', base64Data: canvas.toDataURL().split(',')[1] });
    };
    const small = await image(320, 160, 'Step detail'), large = await image(2400, 1200, 'High-resolution step');
    const s = JSON.parse(localStorage.getItem('lumen.fixture-capture'));
    const reading = { path: 'docs/pages.md', title: '详细推导' };
    const row = (id, title, x, y, extra = {}) => ({ id, title, x, y, w: 330, docs: [], created_at: '', updated_at: '', ...extra });
    s.boards.board.nodes = [row('parent', '上级主题', 400, 40), row('sibling-a', '同层 A', 80, 240), row('sibling-c', '同层 C', 950, 240),
      row('focus-b', '分支 B', 420, 210, { docs: [reading], flow: { nodeIds: ['focus-text', 'focus-small', 'focus-large'] } }),
      row('focus-child', '分支下一级', 820, 460, { flow: { nodeIds: ['closed-step'] } }), row('focus-leaf', '更下一级', 970, 620),
      row('related', '仅相关', 60, 690), row('focus-text', '步骤一的推导', 0, 0, { flowOwnerId: 'focus-b', docs: [reading] }),
      row('focus-small', '', 0, 0, { sticker: true, imageAspect: 2, docs: [small], flowOwnerId: 'focus-b' }),
      row('focus-large', '', 0, 0, { sticker: true, imageAspect: 2, docs: [large], flowOwnerId: 'focus-b' }),
      row('closed-step', '后代自己的流程', 0, 0, { flowOwnerId: 'focus-child' })];
    s.boards.board.edges = [['parent', 'sibling-a'], ['parent', 'focus-b'], ['parent', 'sibling-c'], ['focus-b', 'focus-child'],
      ['focus-child', 'focus-leaf'], ['focus-b', 'related', false], ['focus-text', 'focus-small'], ['focus-small', 'focus-large']]
      .map(([from, to, directed = true], i) => ({ id: `focus-edge-${i}`, from, to, directed, created_at: '', label: i === 3 ? '下一步 $\\nu^2$' : null }));
    s.boards.board.viewport = { x: 26, y: 37, zoom: 0.85 };
    localStorage.setItem('lumen.fixture-capture', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__fixtureReactMounted);
  await page.getByText('桌面夹', { exact: true }).dblclick(); await page.getByText('分页与子流程', { exact: true }).click();
  const focus = page.locator('.board-branch-focus'), normal = page.locator('.board-canvas-live');
  const enter = page.getByRole('button', { name: '开启专注视图', exact: true });
  const exit = page.getByRole('button', { name: '退出专注视图', exact: true });
  const inside = id => focus.locator(`[data-node-id="${id}"]`);
  const originalPager = card('focus-b').locator('.node-preview');
  const stepPager = normal.locator('[data-flow-step="focus-text"] .node-preview');
  await originalPager.getByRole('button', { name: '下一页', exact: true }).click();
  await card('focus-b').locator('.node-title').click();
  await stepPager.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  await normal.locator('.flow-scroll').evaluate(el => { el.scrollTop = Math.min(85, el.scrollHeight - el.clientHeight); });
  const baseline = await state();
  const viewBefore = await normal.locator('.canvas-world').getAttribute('style');
  const scrollBefore = await normal.locator('.flow-scroll').evaluate(el => el.scrollTop);
  const pagesBefore = await Promise.all([originalPager, stepPager].map(pager => pager.getAttribute('data-preview-page')));
  assert.deepEqual(pagesBefore, ['1', '1']);
  assert.ok(scrollBefore > 0);
  await page.screenshot({ path: path.join(out, 'focus-before.png'), animations: 'disabled' });
  await enter.click(); await focus.waitFor();
  assert.equal(await focus.getAttribute('data-focus-root'), 'focus-b');
  assert.equal(await normal.evaluate(el => el.inert && getComputedStyle(el).visibility === 'hidden'), true);
  const rootPreview = inside('focus-b').locator('.node-preview');
  assert.equal(await rootPreview.getAttribute('data-preview-page'), '1');
  await rootPreview.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await rootPreview.getAttribute('data-preview-page'), '2');
  await focus.locator('.edge-label-rendered .katex').waitFor();
  const fitBranch = focus.getByRole('button', { name: '适配整个分支', exact: true });
  await fitBranch.click();
  await inside('focus-large').locator('img').waitFor();
  await inside('focus-small').locator('img').waitFor();
  await page.waitForFunction(() => {
    const small = document.querySelector('.board-branch-focus [data-node-id="focus-small"] img');
    const large = document.querySelector('.board-branch-focus [data-node-id="focus-large"] img');
    return small?.naturalWidth === 320 && large?.naturalWidth === 2400 && large.offsetWidth > small.offsetWidth * 2;
  });
  await fitBranch.click();
  assert.deepEqual((await focus.locator('[data-node-id]').evaluateAll(els => els.map(el => el.dataset.nodeId))).sort(),
    ['focus-b', 'focus-child', 'focus-large', 'focus-leaf', 'focus-small', 'focus-text']);
  assert.equal(await focus.locator('path.focus-step-line').count(), 3);
  assert.equal(await focus.locator('path[data-from="focus-b"][data-to="focus-child"][marker-end]').count(), 1);
  const flowStyling = await focus.evaluate(el => {
    const marker = getComputedStyle(el.querySelector('.branch-focus-card.is-flow-step'), '::before');
    const plain = getComputedStyle(el.querySelector('.branch-focus-card:not(.is-flow-step)'), '::before');
    return { shadow: marker.boxShadow, offset: parseFloat(marker.left), otherMarker: plain.content,
      stepStroke: getComputedStyle(el.querySelector('.focus-step-line')).stroke,
      branchStroke: getComputedStyle(el.querySelector('.edge-line:not(.focus-step-line)')).stroke };
  });
  assert.notEqual(flowStyling.shadow, 'none'); assert.ok(flowStyling.offset < 0);
  assert.equal(flowStyling.otherMarker, 'none'); assert.notEqual(flowStyling.stepStroke, flowStyling.branchStroke);
  await inside('focus-child').locator('.node-title').click();
  assert.equal(await inside('closed-step').count(), 0);
  const dimensions = await inside('focus-large').locator('img').evaluate(el => ({ ratio: el.offsetWidth / el.offsetHeight, width: el.offsetWidth, original: el.naturalWidth }));
  assert.ok(Math.abs(dimensions.ratio - 2) < 0.015 && dimensions.width > 900 && dimensions.original === 2400);
  await page.screenshot({ path: path.join(out, 'focus-branch-and-flow.png'), animations: 'disabled' });
  check('focus follows outgoing descendants and distinguishes only the selected owner’s steps with side glow, tinted arrows and proportional images');

  const focusWorld = focus.locator('.canvas-world');
  const unselected = inside('focus-leaf');
  const leafPosition = () => unselected.evaluate(el => ({ left: el.parentElement.style.left, top: el.parentElement.style.top }));
  const dragLeaf = async (dx, dy) => {
    const title = await unselected.locator('.node-title').boundingBox();
    const x = Math.round(title.x + title.width / 2), y = Math.round(title.y + title.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  };
  const originalLeaf = await leafPosition();
  const originalCamera = await focusWorld.getAttribute('style');
  await dragLeaf(52, -34);
  assert.deepEqual(await leafPosition(), originalLeaf);
  assert.notEqual(await focusWorld.getAttribute('style'), originalCamera);
  assert.equal(await unselected.evaluate(el => el.classList.contains('is-selected')), false);
  await unselected.locator('.node-title').click();
  assert.equal(await unselected.evaluate(el => el.classList.contains('is-selected')), true);
  const focusFit = await focusWorld.getAttribute('style');
  const leafEdge = focus.locator('path[data-to="focus-leaf"]');
  const originalPath = await leafEdge.getAttribute('d');
  await dragLeaf(-30, 44);
  assert.notDeepEqual(await leafPosition(), originalLeaf);
  assert.notEqual(await leafEdge.getAttribute('d'), originalPath);
  assert.equal(await focusWorld.getAttribute('style'), focusFit);
  check('focus pans when dragging from an unselected node and temporarily moves a selected node with its edge');
  const viewport = await focus.boundingBox();
  await page.mouse.move(viewport.x + viewport.width - 65, viewport.y + 145); await page.mouse.wheel(0, -240);
  await page.waitForFunction(previous => document.querySelector('.board-branch-focus .canvas-world')?.getAttribute('style') !== previous, focusFit);
  const zoomed = await focusWorld.getAttribute('style');
  const titlebar = await page.locator('.titlebar').boundingBox();
  const canvasTop = Math.max(viewport.y, titlebar.y + titlebar.height);
  await page.mouse.move(viewport.x + viewport.width - 30, canvasTop + 16);
  await page.mouse.down(); await page.mouse.move(viewport.x + viewport.width - 168, canvasTop + 68, { steps: 7 }); await page.mouse.up();
  assert.notEqual(await focusWorld.getAttribute('style'), zoomed);
  await page.keyboard.press('Backspace'); await page.keyboard.press('ArrowRight');
  await page.evaluate(() => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '这里不能新增节点'); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData })); });
  await page.setViewportSize({ width: 720, height: 650 });
  await focus.getByRole('button', { name: '回到起点', exact: true }).click();
  const bar = await exit.boundingBox(); assert.ok(bar.x >= 0 && bar.x + bar.width <= 720);
  await page.screenshot({ path: path.join(out, 'focus-720.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await exit.click(); await focus.waitFor({ state: 'detached' });
  assert.equal(await normal.locator('.canvas-world').getAttribute('style'), viewBefore);
  assert.equal(await normal.locator('.flow-scroll').evaluate(el => el.scrollTop), scrollBefore);
  assert.deepEqual(await Promise.all([originalPager, stepPager].map(pager => pager.getAttribute('data-preview-page'))), pagesBefore);
  assert.equal(await card('focus-b').evaluate(el => el.classList.contains('is-selected')), true);
  assert.deepEqual(await state(), baseline);
  await enter.click(); await rootPreview.waitFor(); assert.equal(await rootPreview.getAttribute('data-preview-page'), '1');
  await page.keyboard.press('Escape'); await focus.waitFor({ state: 'detached' });
  assert.equal(await normal.locator('.canvas-world').getAttribute('style'), viewBefore);
  assert.deepEqual(await state(), baseline);
  await page.screenshot({ path: path.join(out, 'focus-restored.png'), animations: 'disabled' });
  check('zoom, temporary resize and paging in focus leave the original camera, selection, steps, saved board and reading positions as they were');

  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('lumen.fixture-capture'));
    const board = s.boards.board;
    const small = board.nodes.find(node => node.id === 'focus-small').docs[0];
    const large = board.nodes.find(node => node.id === 'focus-large').docs[0];
    const make = (id, title, x, y, w, docs) => ({ id, title, x, y, w, docs, created_at: '', updated_at: '' });
    board.nodes = [
      { ...make('photos', '', 140, 280, 160, [small]), h: 80, sticker: true, imageAspect: 2 },
      make('legacy', '离屏旧贴图', 4500, 340, 1440, [large]),
      make('captioned', '带标题的贴图', 780, 290, 320, []),
    ];
    board.edges = [];
    board.viewport = { x: 0, y: 0, zoom: 0.46 };
    localStorage.setItem('lumen.fixture-capture', JSON.stringify(s));
  });
  const openMaterialsBoard = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fixtureReactMounted);
    await page.getByText('桌面夹', { exact: true }).dblclick();
    await page.getByText('分页与子流程', { exact: true }).click();
  };
  await openMaterialsBoard();
  const pastePhoto = (width, height, color, intoPanel = true) => page.evaluate(({ width, height, color, intoPanel }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), value => value.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'synthetic-image.png', { type: 'image/png' }));
    (intoPanel ? document.querySelector('.np-title') : window).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { width, height, color, intoPanel });
  const photos = card('photos'), captioned = card('captioned');
  const photoNext = photos.getByRole('button', { name: '下一个素材', exact: true });
  const photoPrev = photos.getByRole('button', { name: '上一个素材', exact: true });
  const notice = page.locator('.document-import-status');
  const savedBoard = () => page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  const closePanel = () => page.locator('.np-close').click();
  const waitPixels = (id, width) => page.waitForFunction(({ id, width }) => document.querySelector(`.canvas-world>[data-node-id="${id}"] .sticker-image`)?.naturalWidth === width, { id, width });
  const imageWidth = node => node.locator('.sticker-image').evaluate(el => el.offsetWidth);

  await waitPixels('photos', 320);
  assert.equal(await photoNext.count(), 0);
  await photos.click();
  await pastePhoto(1000, 500, '#2f7c63');
  await photoNext.waitFor();
  await closePanel();
  const viewportWidth = (await photoNext.boundingBox()).width;
  assert.ok(viewportWidth >= 23, `pager target at 46% must be usable, got ${viewportWidth}px`);
  assert.equal(await photoPrev.count(), 0);
  const waitImageControls = opacity => page.waitForFunction(expected => {
    const controls = document.querySelectorAll('[data-node-id="photos"] .node-preview :is(.node-preview-turn,.node-preview-progress)');
    return controls.length === 2 && [...controls].every(control => getComputedStyle(control).opacity === expected);
  }, opacity);
  await waitImageControls('0');
  assert.equal(await photoNext.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await photos.locator('.node-preview').hover();
  await waitImageControls('1');
  await page.mouse.move(1050, 650);
  await waitImageControls('0');
  await photoNext.focus();
  await waitImageControls('1');
  await photoNext.evaluate(el => el.blur());
  await waitImageControls('0');
  check('image pager and page number fade on preview hover, also reveal for keyboard focus, and hidden buttons do not intercept the pointer');
  await turnMaterial(photoNext);
  await waitPixels('photos', 1000);
  assert.equal(await imageWidth(photos), 550);
  assert.equal(await photos.locator('.node-preview-material-number').textContent(), '2');
  assert.equal(await photoNext.count(), 0);
  assert.equal(await page.locator('.node-panel').count(), 0);
  await page.screenshot({ path: path.join(out, 'two-images-46-percent.png') });
  await turnMaterial(photoPrev); await waitPixels('photos', 320);
  assert.equal(await imageWidth(photos), 160);
  check('a second attachment adds a full-size material button at 46% zoom and both directions load the correct aspect-preserving picture');

  await captioned.click();
  await pastePhoto(800, 400, '#297d92');
  await notice.getByText('已挂载图片', { exact: true }).waitFor();
  await waitPixels('captioned', 800);
  assert.ok(Math.abs(await imageWidth(captioned) - 440) <= 2);
  await page.evaluate(() => {
    window.__imageNoticeFaded = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.document-import-status.is-fading')) {
        window.__imageNoticeFaded = true;
        observer.disconnect();
      }
    });
    observer.observe(document.querySelector('.board-canvas-live'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.waitForTimeout(1000);
  await pastePhoto(960, 300, '#72588b');
  await page.waitForFunction(() => document.querySelectorAll('[data-node-id="captioned"] .node-preview-next').length === 1);
  await page.waitForTimeout(2150);
  assert.equal(await notice.getByText('已挂载图片', { exact: true }).count(), 1);
  await page.waitForFunction(() => window.__imageNoticeFaded);
  await notice.waitFor({ state: 'detached' });
  await closePanel();
  await turnMaterial(captioned.getByRole('button', { name: '下一个素材', exact: true }));
  await waitPixels('captioned', 960);
  assert.ok(Math.abs(await imageWidth(captioned) - 528) <= 2);
  check('titled nodes show both image attachments and repeated successes each receive their own three-second fade-out');

  await turnMaterial(photoNext); await waitPixels('photos', 1000);
  await photos.click(); await closePanel();
  await photos.hover();
  const resizeHandle = photos.locator('.node-resize-handle.corner-se');
  await resizeHandle.hover();
  const corner = await resizeHandle.boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 46, corner.y + corner.height / 2 + 23, { steps: 6 });
  await page.mouse.up();
  await savedBoard();
  const resized = (await state()).boards.board.nodes.find(node => node.id === 'photos').docs[1].imageDisplay;
  assert.ok(resized.resized && Math.abs(resized.width - 650) <= 2);
  await page.mouse.click(1000, 610);
  await pastePhoto(1200, 600, '#c4a274', false);
  await notice.getByText('已插入贴图', { exact: true }).waitFor();
  await savedBoard();
  const added = (await state()).boards.board.nodes.find(node => node.docs[0]?.imageDisplay?.pixelWidth === 1200);
  assert.equal(added.w, 660);
  assert.equal(added.h, 330);
  await openMaterialsBoard();
  await waitPixels(added.id, 1200);
  assert.equal(await imageWidth(card(added.id)), 660);
  assert.ok(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('lumen.image-sizing.v1.') && JSON.parse(localStorage.getItem(key)).ratio === 0.55)));
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 61_000; });
  await captioned.click();
  await pastePhoto(600, 300, '#2f4f68');
  await notice.getByText('已挂载图片', { exact: true }).waitFor();
  await savedBoard();
  const latest = (await state()).boards.board.nodes.find(node => node.id === 'captioned').docs.at(-1).imageDisplay;
  assert.ok(Math.abs(latest.width - (0.5 + 0.6 + resized.width / 1000) / 3 * 600) < 1);
  check('legacy sizes seed a board average, manual resize persists per attachment, and the next periodic refresh ignores automatic placements');

  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'material-pages-report.json'),JSON.stringify({browser:'WebKit',fallback:'Browser plugin not available',pageIdentity:true,notBlank:true,noOverlay:true,checks,errors,documentPages:count,paragraphsSeen:seen.size},null,2));console.log(JSON.stringify({checks:checks.length,errors,pages:count}));
 }catch(e){await page.screenshot({path:path.join(out,'material-failure.png')});fs.writeFileSync(path.join(out,'material-failure.txt'),e.stack+'\n'+JSON.stringify(errors));throw e;}finally{await browser.close();}
})();
