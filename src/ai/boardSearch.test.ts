import {expect,it,vi} from 'vitest';
import {searchBoard} from './boardSearch';
import {executeTool} from './tools';
import {focusedNodeContext,buildBoardContext,estimateTokens,boardToolPage} from './boardContext';
import type {BoardFile,BoardNode} from '../api';
const node=(id:string,title:string,summary:string,paths:string[]):BoardNode=>({id,title,summary,x:0,y:0,w:200,docs:paths.map(path=>({path,title:path})),created_at:'',updated_at:''});
const board:BoardFile={version:1,id:'b',projectId:'p',name:'Search',nodes:[node('n1','蒸馏','保留解释',['shared.md','second.md']),node('n2','另一个方向','',['shared.md'])],edges:[],viewport:{x:0,y:0,zoom:1},created_at:'',updated_at:''};
it('combines keywords across title, summary and later documents with exact read locators',async()=>{
 const read=vi.fn(async(path:string)=>path==='second.md'?'prefix '.repeat(40)+'独有的证据':'共享正文');const result=JSON.parse(await searchBoard(board,{keywords:['蒸馏','解释','证据'],mode:'all'},read));
 expect(result.hits.map((h:{nodeId:string})=>h.nodeId)).toEqual(['n1']);expect(read).toHaveBeenCalledTimes(2);const found=result.hits[0].matches.find((m:{field:string})=>m.field==='文档命中');expect(found.docIndex).toBe(1);const page=await executeTool('read_node_doc',{nodeId:'n1',docIndex:found.docIndex,offset:found.offset},{board,readDoc:read});expect(page).toContain('独有的证据');
});
it('OR synonyms, ranking and pagination do not hide later mounted documents',async()=>{
 const result=JSON.parse(await searchBoard(board,{keywords:['蒸馏','共享'],limit:1},async()=>'共享正文'));expect(result.total).toBe(2);expect(result.hits[0].nodeId).toBe('n1');expect(result.nextOffset).toBe(1);
 const next=JSON.parse(await searchBoard(board,{keywords:['蒸馏','共享'],offset:1,limit:1},async()=>'共享正文'));expect(next.hits[0].nodeId).toBe('n2');expect(next.nextOffset).toBeNull();
});
it('reports unreadable materials and cancellation instead of claiming exhaustive absence',async()=>{
 const failure=JSON.parse(await searchBoard(board,{query:'missing'},async()=>{throw Error('synthetic failure');}));expect(failure.unreadableDocuments).toBe(2);expect(failure.message).toContain('不完整');
 const read=vi.fn(async()=>'');const stopped=JSON.parse(await searchBoard(board,{query:'missing'},read,()=>true));expect(stopped.cancelled).toBe(true);expect(read).not.toHaveBeenCalled();
});
it('validates ranges and returns document metadata without reading original content',async()=>{
 const read=vi.fn(async()=>'');const ctx={board,readDoc:read};expect(await executeTool('read_node_doc',{nodeId:'n1',docIndex:0.5},ctx)).toContain('越界');expect(read).not.toHaveBeenCalled();
 const metadata=JSON.parse(await executeTool('read_node_doc',{nodeId:'n1',metadataOnly:true},ctx));expect(metadata.documents[1].docIndex).toBe(1);expect(read).not.toHaveBeenCalled();expect(await searchBoard(board,{keywords:Array(9).fill('a').map((s,i)=>s+i)},read)).toContain('最多8');
});
it('document segments state their continuation without pretending to contain the whole source',async()=>{
 const original='a'.repeat(300)+'末尾';const readDoc=async()=>original;const first=await executeTool('read_node_doc',{nodeId:'n1',length:100},{board,readDoc});expect(first).toContain('nextOffset=100');expect(first).not.toContain('末尾');const last=await executeTool('read_node_doc',{nodeId:'n1',offset:300},{board,readDoc});expect(last).toContain('nextOffset=null');expect(last).toContain('末尾');
});
it('node context retains identity and a document directory, never an automatic body',()=>{
 const context=focusedNodeContext(board,'n1');expect(context).toContain('#n1');expect(context).toContain('docIndex=1');expect(context).toContain('正文尚未提供');expect(context).not.toContain('共享正文');
});
it('literal regex characters and Unicode do not corrupt match offsets or stall tiny document segments',async()=>{
 const readDoc=async()=> 'İ'.repeat(80)+'[A+B] 🧠';const result=JSON.parse(await searchBoard(board,{query:'[a+b]'},readDoc));const match=result.hits[0].matches.find((m:{field:string})=>m.field==='文档命中');expect(match.offset).toBe(30);
 const part=await executeTool('read_node_doc',{nodeId:'n1',offset:86,length:1},{board,readDoc});expect(part).toContain('🧠');expect(part).toContain('nextOffset=null');
});
it('a tight response allowance keeps valid locators and an honest next page instead of slicing JSON',async()=>{
 const result=JSON.parse(await searchBoard(board,{query:'共享'},async()=>'共享'.repeat(500),()=>false,400));expect(result.hits[0].nodeId).toBe('n1');expect(result.nextOffset).toBe(1);expect(JSON.stringify(result).length).toBeLessThanOrEqual(400);
});
it('many early matches for one keyword do not evict the unique later keyword locator',async()=>{
 const many={...board,nodes:[node('n1','Topic','',Array.from({length:10},(_,i)=>'doc'+i))]};const result=JSON.parse(await searchBoard(many,{keywords:['A','B'],mode:'all'},async p=>p==='doc9'?'B':'A'));expect(result.hits[0].matches.some((m:{keyword:string;docIndex:number})=>m.keyword==='B'&&m.docIndex===9)).toBe(true);
});
it('large board routing and structure pages are bounded, honest and resumable',()=>{
 const large={...board,nodes:Array.from({length:1000},(_,i)=>node('n'+i,'主题'+i,'说明'.repeat(50),[]))};const context=buildBoardContext(large,8000);expect(estimateTokens(context)).toBeLessThanOrEqual(1600);expect(context).toContain('部分目录');expect(context).toContain('search_board');const page=boardToolPage(large,{offset:80,limit:2},1000);expect(page).toContain('#n80');expect(page).toContain('#n81');expect(page).not.toContain('#n82 ');expect(page).toContain('nextOffset=82');expect(page.length).toBeLessThanOrEqual(1000);
 expect(boardToolPage(large,{},256)).toContain('未提供重复分页游标');
});
it('tiny metadata and outline budgets do not return thousands of characters',async()=>{
 const many={...board,nodes:[{...board.nodes[0],docs:Array.from({length:20},(_,i)=>({path:'d'+i,title:'长标题'.repeat(200)}))}]};const readDoc=vi.fn(async()=>'');const result=await executeTool('read_node_doc',{nodeId:'n1',metadataOnly:true},{board:many,readDoc,maxDocChars:128});expect(result.length).toBeLessThanOrEqual(128);expect(JSON.parse(result).budgetLimited).toBe(true);expect(readDoc).not.toHaveBeenCalled();expect((await executeTool('read_board_outline',{},{board:many,readDoc,maxDocChars:128})).length).toBeLessThanOrEqual(128);
});
