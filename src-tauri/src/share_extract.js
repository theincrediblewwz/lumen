(() => {
 const cache=window.__LUMEN_SHARE_SCAN?(window.__LUMEN_SHARE_CLEAN_V2||(window.__LUMEN_SHARE_CLEAN_V2={entries:new WeakMap(),version:0})):null;
 if(cache&&!cache.observer){cache.observer=new MutationObserver(records=>{for(const record of records){for(let node=record.target.nodeType===1?record.target:record.target.parentElement;node;node=node.parentElement){const entry=cache.entries.get(node);if(entry)entry.dirty=true;}}});cache.observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});}
 const clean=el=>{
 const cached=cache?.entries.get(el);if(cached&&!cached.dirty)return cached.text;
 const literals=[];let visited=0;let marker='\uE000LUMEN_LITERAL_';while((el.textContent||'').includes(marker))marker+='_';
 const literal=text=>{const token=marker+literals.length+'\uE001';literals.push(text);return token;};
 const restore=text=>text.replace(new RegExp(marker+'(\\d+)\uE001','g'),(_,i,offset)=>{const prefix=text.slice(text.lastIndexOf('\n',offset)+1,offset),list=prefix.match(/^([ \t]*(?:> ?[ \t]*)*)([-+*] |\d+[.)] )$/);const indent=list?list[1]+' '.repeat(list[2].length):/^(?:[ \t]|> ?)*$/.test(prefix)?prefix:'';return literals[Number(i)].replace(/\n/g,'\n'+indent);});
 const codeText=node=>node.nodeType===3?node.nodeValue||'':node.nodeType!==1?'':node.tagName==='BR'?'\n':node.matches('button,[hidden]')?'':Array.from(node.childNodes).map(codeText).join('');
 const convert=node=>{
  if(++visited>2000000)throw Error('当前消息页面结构超过处理预算，原文未截断');
  if(node.nodeType===3)return (node.textContent||'').replace(/[ \t\r\n]+/g,' ').split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$[^\n$]+\$)/g).map((part,i)=>i%2?literal(part):part.replace(/([\\`*_{}\[\]<>!#|~])/g,'\\$1')).join('');
  if(node.nodeType!==1)return '';
  const tag=node.tagName.toLowerCase();
  if(node.matches('script,style,button,svg,noscript,iframe,template,annotation,annotation-xml,[hidden],[aria-hidden="true"],[role="toolbar"],[data-message-channel="analysis"],[data-testid="reasoning-content"]'))return '';
  const latex=node.querySelector?.('annotation[encoding="application/x-tex"]');
  if(!node.closest('pre,code')&&node.matches('[data-math-source],.katex-display,.katex,math,[role="math"]')){
   let tex=node.getAttribute('data-math-source')||latex?.textContent;
   if(tex){let display=node.matches('.katex-display,.math-display')||node.getAttribute('display')==='block'||/^(block|display|true)$/.test(node.getAttribute('data-math-type')||node.getAttribute('data-display')||node.getAttribute('data-math-display')||'')||!!node.querySelector('math[display="block"]');
    for(const[a,b,d]of [['\\[','\\]',true],['\\(','\\)',false],['$$','$$',true],['$','$',false]])if(tex.startsWith(a)&&tex.endsWith(b)&&tex.length>=a.length+b.length){tex=tex.slice(a.length,-b.length);display=display||d;break;}
    display=display||/[\r\n]/.test(tex);return display?'\n\n'+literal('$$\n'+tex+'\n$$')+'\n\n':literal('$'+tex+'$');
   }
   return '[公式源码缺失] '+(node.querySelector('.katex-html')?.textContent||node.getAttribute('aria-label')||node.textContent||'');
  }
  if(tag==='pre'){const code=node.querySelector('code')||node;const text=codeText(code);const runs=text.match(/`+/g)||[];const fence='`'.repeat(Math.max(3,...runs.map(s=>s.length+1)));const lang=(code.className.match(/language-([\w+-]+)/)||[])[1]||'';return '\n\n'+literal(fence+lang+'\n'+text+'\n'+fence)+'\n\n';}
  if(tag==='code'){const text=codeText(node),runs=text.match(/`+/g)||[],fence='`'.repeat(Math.max(/[\r\n]/.test(text)?3:1,...runs.map(s=>s.length+1))),pad=/^[` ]|[` ]$/.test(text)?' ':'';return /[\r\n]/.test(text)?'\n\n'+literal(fence+'\n'+text+'\n'+fence)+'\n\n':literal(fence+pad+text+pad+fence);}
  if(tag==='ul'||tag==='ol'){const start=Number(node.getAttribute('start'))||1;return '\n\n'+Array.from(node.children).filter(c=>c.tagName==='LI').map((item,i)=>{const prefix=tag==='ol'?`${start+i}. `:'- ',text=Array.from(item.childNodes).map(convert).join('').trim();return prefix+text.replace(/\n/g,'\n'+' '.repeat(prefix.length));}).join('\n')+'\n\n';}
  if(tag==='table'){
   const cells=Array.from(node.querySelectorAll('tr')).filter(tr=>tr.closest('table')===node).map(tr=>Array.from(tr.children).filter(c=>['TD','TH'].includes(c.tagName)));
   const converted=cells.map(row=>row.map(c=>restore(convert(c)).trim()));
   const complex=converted.flat().some(text=>/[\r\n]/.test(text))||cells.flat().some(c=>Number(c.getAttribute('colspan'))>1||Number(c.getAttribute('rowspan'))>1||c.querySelector('ul,ol,blockquote,table'));
   if(complex)return '\n\n> 复杂表格按原行与单元格展开，合并范围在标签中保留。\n\n'+cells.map((row,r)=>row.map((c,i)=>`**第${r+1}行 · 第${i+1}格（跨${Number(c.getAttribute('colspan'))||1}列、${Number(c.getAttribute('rowspan'))||1}行）**\n\n${literal(converted[r][i])}`).join('\n\n')).join('\n\n')+'\n\n';
   const rows=converted.map(row=>row.map(text=>text.replace(/\\?\|/g,'\\|')));if(!rows.length)return '';return '\n\n'+literal(rows.map((row,i)=>'| '+row.join(' | ')+' |'+(i===0?'\n| '+row.map(()=>'---').join(' | ')+' |':'')).join('\n'))+'\n\n';
  }
  const text=Array.from(node.childNodes).map(convert).join('');
  if(/^h[1-6]$/.test(tag))return '\n\n'+'#'.repeat(Number(tag[1]))+' '+text.trim()+'\n\n';
  if(tag==='br')return '\n';
  if(tag==='blockquote')return '\n\n'+text.trim().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
  if(['p','div','section','article'].includes(tag))return '\n\n'+text.trim()+'\n\n';
  if(tag==='strong'||tag==='b')return '**'+text+'**';
  if(tag==='em'||tag==='i')return '*'+text+'*';
  if(tag==='a'){try{const url=new URL(node.getAttribute('href'),location.href);if(['http:','https:'].includes(url.protocol))return '['+text+']('+url.href.replace(/[()]/g,c=>encodeURIComponent(c))+')';}catch{}return text;}
  if(tag==='img')return node.getAttribute('alt')?'[图片：'+node.getAttribute('alt')+']':'';
  return text;
 };
 const text=restore(convert(el).replace(/\n[ \t]+\n/g,'\n\n').replace(/\n{3,}/g,'\n\n').trim());
 if(cache)cache.entries.set(el,{text,dirty:false,version:cached?.text===text?cached.version:++cache.version});return text;
 };
 const visible=el=>{if(el.closest('[hidden],[aria-hidden="true"]'))return false;for(let node=el;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return false;}return true;};
 let messages=[],messageElements=[];
 const message=(el,role,body=el)=>{const content=clean(body);if(!content)return null;messageElements.push(el);return {role,content};};
 if(location.hostname==='chat.deepseek.com'){
  messages=Array.from(document.querySelectorAll('.ds-message')).filter(visible).map(el=>{const answer=el.querySelector('.ds-assistant-message-main-content');if(answer)return message(el,'assistant',answer);if(el.querySelector('.ds-markdown'))return null;return message(el,'user',el.firstElementChild||el);}).filter(Boolean);
 }else if(['chatgpt.com','chat.openai.com'].includes(location.hostname)){
  const selector='[data-message-author-role="user"],[data-message-author-role="assistant"],[data-assistant-markdown-root],[data-assistant-markdown],[data-conversation-role="assistant"],[data-markdown-text-style="assistant-message"],[data-chatgpt-search-unit-key$=":assistant"]';
  messages=Array.from(document.querySelectorAll(selector)).filter(el=>visible(el)&&!el.parentElement?.closest(selector)).map(el=>message(el,el.getAttribute('data-message-author-role')==='user'?'user':'assistant')).filter(Boolean);
 }else if(['www.doubao.com','doubao.com'].includes(location.hostname)){
  messages=Array.from(document.querySelectorAll('[data-testid="send_message"],[data-testid="receive_message"]')).filter(visible).map(el=>{const user=el.getAttribute('data-testid')==='send_message';const body=el.querySelector(user?'.send-text-content-coco,.md-box-root':'[data-testid="message_text_content"]');return body?message(el,user?'user':'assistant',body):null;}).filter(Boolean);
 }
 messages=messages.filter(m=>m.content);
 const busy=Array.from(document.querySelectorAll('main[aria-busy="true"],.ds-message[aria-busy="true"],.ds-assistant-message-main-content[aria-busy="true"],[data-message-author-role][aria-busy="true"],[data-testid="receive_message"][aria-busy="true"],[role="progressbar"],[data-testid="conversation-loading"]')).some(visible);
 const snapshot={url:location.href,title:document.title,messages,ready:document.readyState!=='loading'&&!busy,attachments:document.querySelectorAll('img').length>0};
 if(!window.__LUMEN_SHARE_SCAN)return snapshot;
 const key='__LUMEN_SHARE_COLLECTION_V2';
 const state=window[key]||(window[key]={phase:'top',entries:new Map(),sizes:new Map(),elements:new WeakMap(),positions:new WeakMap(),next:0,signature:'',stable:Date.now(),topSeen:false,bytes:0});
 const nodes=messageElements;
 let scroller=document.scrollingElement||document.documentElement;
 for(let node=nodes[0]?.parentElement;node;node=node.parentElement){const style=getComputedStyle(node);if(/auto|scroll/.test(style.overflowY)&&node.clientHeight>0&&node.scrollHeight>node.clientHeight+2){scroller=node;break;}}
 const height=scroller.scrollHeight,view=scroller.clientHeight||innerHeight,top=scroller.scrollTop;
 const signature=height+'|'+messages.map((message,index)=>message.role+':'+cache.entries.get(messageElements[index])?.version).join('\u0001');
 if(signature!==state.signature||busy){state.signature=signature;state.stable=Date.now();if(state.phase==='complete')state.phase='down';}
 const settled=Date.now()-state.stable;
 const more=Array.from(document.querySelectorAll('button')).find(el=>visible(el)&&!el.disabled&&/^(加载更多(?:消息|对话)?|查看更多(?:消息|对话)?|Load (?:more|older)(?: messages)?|Show more messages|View previous messages)$/i.test(el.textContent.trim()));
 if(state.phase==='top'){
   scroller.scrollTo({top:0,behavior:'instant'});
   if(top>2)state.stable=Date.now();
   else if(more){more.click();state.stable=Date.now();}
   else if(snapshot.ready&&messages.length&&settled>=2000){state.phase='down';state.topSeen=true;state.signature='';}
 }else{
   // A DOM element identity is stable for normal lazy lists. Explicit message/turn
   // IDs (or virtual-list indexes) survive virtualization and equal repeated text.
   const roots=nodes;
   for(let i=0;i<messages.length;i++){
     const message=messages[i],el=roots[i];let identity;
     for(let node=el;node&&node!==scroller;node=node.parentElement){for(const attr of ['data-message-id','data-turn-id','data-index','aria-posinset']){const value=node.getAttribute(attr);if(value){identity=attr+':'+value+':'+message.role;break;}}if(identity)break;const test=node.getAttribute('data-testid');if(test&&/^conversation-turn-\d+$/.test(test)){identity=test+':'+message.role;break;}}
     if(!identity&&el){let virtual=false;for(let node=el;node&&node!==scroller;node=node.parentElement){const style=getComputedStyle(node);if(style.position==='absolute'||style.transform!=='none'){virtual=true;break;}}if(virtual){const absolute=el.getBoundingClientRect().top-scroller.getBoundingClientRect().top+top;identity='position:'+Math.round(absolute)+':'+message.role;state.uncertain=true;}else{if(!state.elements.has(el))state.elements.set(el,++state.next);identity='element:'+state.elements.get(el)+':'+message.role;}}
     if(!identity)identity='position:'+i+':'+message.role;
     const previous=state.entries.get(identity);
     // Recycled anonymous elements need content-sensitive identity. No text-only
     // global deduplication: equal questions in distinct turns must both survive.
     if(previous&&previous.content!==message.content&&!message.content.startsWith(previous.content)&&!previous.content.startsWith(message.content))identity+=':'+message.content;
     const old=state.entries.get(identity);if(old?.content===message.content)continue;
     const size=new TextEncoder().encode(message.content).length;state.bytes+=size-(state.sizes.get(identity)||0);state.sizes.set(identity,size);
     if(state.bytes>32*1024*1024)return {...snapshot,error:'公开正文超过32MiB读取预算；已停止，未截断或替换原文',complete:false};
     state.entries.set(identity,{...message,id:identity});
   }
   if(more){more.click();state.stable=Date.now();}
   else if(top+view<height-3){scroller.scrollTo({top:Math.min(height,top+Math.max(100,view*.7)),behavior:'instant'});}
   else if(state.topSeen&&snapshot.ready&&state.entries.size&&settled>=5000){snapshot.complete=true;snapshot.messages=Array.from(state.entries.values());state.phase='complete';}
 }
 if(state.phase==='complete'){snapshot.complete=true;snapshot.messages=Array.from(state.entries.values());}
 return {...snapshot,total:state.entries.size,phase:state.phase,scrolledTop:state.topSeen,position:top,bytes:state.bytes,...(state.uncertain?{warning:'页面未提供稳定消息编号，已按位置累计；请逐轮核对后选择整理。'}:{})};
})()
