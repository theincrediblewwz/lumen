import type { BoardFile } from '../api';

type Match={field:'标题命中'|'概括命中'|'文档命中';keyword:string;docIndex?:number;docTitle?:string;offset?:number;snippet?:string};
/** Search the full mounted source, but return only bounded locators/excerpts. */
export async function searchBoard(board:BoardFile,args:Record<string,unknown>,readDoc:(path:string)=>Promise<string>,cancelled:()=>boolean=()=>false,maxChars=16000):Promise<string>{
 const supplied=Array.isArray(args.keywords)?args.keywords:[];
 const terms=[...new Set([...(typeof args.query==='string'&&args.query.trim()?[args.query]:[]),...supplied].filter((s):s is string=>typeof s==='string').map(s=>s.trim()).filter(Boolean))];
 if(!terms.length)return '检索词为空，请传query或keywords。';
 if(terms.length>8||terms.some(s=>s.length>160))return '每次最多8个关键词，每词最多160字符。';
 if(args.mode!=null&&!['any','all'].includes(String(args.mode)))return 'mode须为any或all。';
 const all=args.mode==='all';const patterns=terms.map(s=>new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu'));
 const offset=Number(args.offset??0),limit=Number(args.limit??10);
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)return 'offset须为非负整数，limit为1–20。';
 const rows=board.nodes.map(node=>({node,matched:new Set<number>(),docTerms:new Set<number>(),matches:[] as Match[],score:0}));
 const paths=new Map<string,{row:typeof rows[number];docIndex:number;title:string}[]>();
 for(const row of rows){
  for(const[index,pattern]of patterns.entries())for(const[field,value,weight]of [['标题命中',row.node.title,8],['概括命中',row.node.summary??'',4]] as const){if(pattern.test(value)){row.matched.add(index);row.matches.push({field,keyword:terms[index]});row.score+=weight;}}
  row.node.docs.forEach((doc,docIndex)=>{const owners=paths.get(doc.path)??[];owners.push({row,docIndex,title:doc.title});paths.set(doc.path,owners);});
 }
 const entries=[...paths.entries()];let cursor=0,failed=0,scanned=0;
 await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{
  while(!cancelled()){
   const entry=entries[cursor++];if(!entry)break;const[path,owners]=entry;
   try{const content=await readDoc(path);if(cancelled())break;scanned++;
    for(const[index,pattern]of patterns.entries()){const match=pattern.exec(content);if(!match)continue;const position=match.index;
     const snippet=content.slice(Math.max(0,position-50),position+match[0].length+90).replace(/\s+/g,' ');
     for(const owner of owners){const row=owner.row;row.matched.add(index);if(!row.docTerms.has(index)){row.score+=2;row.docTerms.add(index);}const metadata=row.matches.filter(m=>m.docIndex==null),documents=row.matches.filter(m=>m.docIndex!=null);documents.push({field:'文档命中',keyword:terms[index],docIndex:owner.docIndex,docTitle:owner.title.slice(0,180),offset:Math.max(0,position-50),snippet});documents.sort((a,b)=>a.docIndex!-b.docIndex!||a.keyword.localeCompare(b.keyword));const seen=new Set<string>(),diverse=documents.filter(m=>!seen.has(m.keyword)&&!!seen.add(m.keyword));row.matches=[...metadata,...diverse,...documents.filter(m=>!diverse.includes(m))].slice(0,metadata.length+12);}
    }
   }catch{failed++;}
  }
 }));
 if(cancelled())return JSON.stringify({cancelled:true,message:'检索已取消，不代表没有相关内容。'});
 const hits=rows.filter(row=>all?row.matched.size===terms.length:row.matched.size>0).sort((a,b)=>b.matched.size-a.matched.size||b.score-a.score||a.node.id.localeCompare(b.node.id));
 const result={keywords:terms,mode:all?'all':'any',total: hits.length,offset,nextOffset:offset+limit<hits.length?offset+limit:null,scannedDocuments:scanned,unreadableDocuments:failed,
  message:failed?'部分文档无法读取，结果不完整。':hits.length?'检索完成。':'没有找到相关内容。',
  hits:hits.slice(offset,offset+limit).map(row=>({nodeId:row.node.id,title:row.node.title.slice(0,200),summary:row.node.summary?.slice(0,160)??'',matchedKeywords:[...row.matched].sort().map(i=>terms[i]),matches:[...row.matches.filter(m=>m.docIndex==null).slice(0,4),...row.matches.filter(m=>m.docIndex!=null).slice(0,8)]})),
  readHint:'文档命中可用read_node_doc(nodeId,docIndex,offset)读取；offset为正文字符位置。结果可用nextOffset翻页。'};
 while(result.hits.length>1&&JSON.stringify(result).length>maxChars)result.hits.pop();
 result.nextOffset=offset+result.hits.length<hits.length?offset+result.hits.length:null;
 if(JSON.stringify(result).length<=maxChars)return JSON.stringify(result);
 // Preserve a useful locator rather than cutting JSON or silently losing hits.
 const first=result.hits[0],doc=first?.matches.find(m=>m.docIndex!=null);
 const compact={total:hits.length,offset,nextOffset:first&&offset+1<hits.length?offset+1:null,unreadableDocuments:failed,
  hits:first?[{nodeId:first.nodeId,title:first.title.slice(0,60),docIndex:doc?.docIndex,offset:doc?.offset}]:[],message:'剩余预算有限，仅返回首个定位；片段和其他位置已省略，可逐词检索更多位置或翻页。'};
 return JSON.stringify(compact).length<=maxChars?JSON.stringify(compact):JSON.stringify({total:hits.length,unreadableDocuments:failed,budgetLimited:true,message:'检索已完成，但本轮预算不足以返回定位；请缩小问题或增大预算。'});
}
