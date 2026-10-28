import type { StoredMessage } from './chatStore';
import type { ToolDef } from './tools';
export const CONVERSATION_TOOLS:ToolDef[]=[
 {type:'function',function:{name:'search_conversation',description:'检索本次会话完整原始问答（包括摘要覆盖的旧消息），最多8个关键词，返回消息id/角色/字符位置/片段。引用旧内容或记忆不确定时先查原文。只搜索当前会话，不读取其他聊天或白板。',parameters:{type:'object',properties:{keywords:{type:'array',items:{type:'string'},maxItems:8},offset:{type:'integer',minimum:0}},required:['keywords']}}},
 {type:'function',function:{name:'read_conversation',description:'按messageId分段重读当前会话原始消息；不填messageId分页列出消息目录。offset为字符位置，length最多12000，按nextOffset续读。摘要不是原文，不能把一段当整篇。',parameters:{type:'object',properties:{messageId:{type:'string'},offset:{type:'integer',minimum:0},length:{type:'integer',minimum:1,maximum:12000}},required:[]}}}
];
export function conversationTool(name:string,args:Record<string,unknown>,messages:StoredMessage[],maxChars=12000):string{
 const cap=Math.min(16000,Math.max(0,maxChars));if(cap<400)return '上下文空间不足，尚未返回原对话。请说明限制或增大预算后再读。';
 const bounded=(value:unknown)=>{const raw=JSON.stringify(value);return raw.length<=cap?raw:'上下文空间不足以返回一个完整原文条目，未提供重复游标；请增大预算。';};
 const offset=Number(args.offset??0);if(!Number.isInteger(offset)||offset<0)return 'offset须为非负整数。';
 const items=messages.map((m,i)=>({...m,id:m.id??`message_${i}`}));
 if(name==='search_conversation'){
   if(!Array.isArray(args.keywords)||args.keywords.length<1||args.keywords.length>8||args.keywords.some(k=>typeof k!=='string'||!k.trim()||k.length>160))return '请提供1–8个非空关键词，每词最多160字符。';
   const keywords=[...new Set(args.keywords as string[])];
   const matchers=keywords.map(k=>new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu'));
   // One locator per message/keyword; bounded response, independent of repeated hits.
   const hits:Array<{messageId:string;role:string;offset:number;snippet:string;error?:boolean}>=[];let totalHits=0;
   for(const m of items){const matches=matchers.map(re=>re.exec(m.content)).filter((m):m is RegExpExecArray=>!!m).sort((a,b)=>a.index-b.index);
     for(const match of matches){const start=Math.max(0,match.index-90);if(totalHits>=offset&&hits.length<12)hits.push({messageId:m.id,role:m.role,offset:match.index,snippet:m.content.slice(start,start+260),error:m.error});totalHits++;}
   }
   const page:typeof hits=[];for(const hit of hits){if(JSON.stringify([...page,hit]).length+180>cap)break;page.push(hit);}
   if(!page.length&&offset<totalHits)return bounded({budgetLimited:true,totalHits,hits:[],nextOffset:null,note:'不足以返回完整条目，请增大预算。'});
   return bounded({totalHits,hits:page,nextOffset:offset+page.length<totalHits?offset+page.length:null,scope:'仅当前会话原始问答；错误或中止回答不能当确定结论'});
 }
 const id=args.messageId;if(id==null||id===''){
   const rows=[];let i=offset;for(;i<Math.min(items.length,offset+20);i++){const m=items[i],row={messageId:m.id,role:m.role,totalChars:m.content.length,error:!!m.error,preview:m.content.slice(0,100)};if(JSON.stringify([...rows,row]).length+180>cap)break;rows.push(row);}
   if(!rows.length&&offset<items.length)return bounded({budgetLimited:true,messages:[],nextOffset:null,note:'不足以返回完整目录条目，请增大预算。'});
   return bounded({totalMessages:items.length,messages:rows,nextOffset:i<items.length?i:null});
 }
 const m=items.find(m=>m.id===id);if(!m)return '当前会话没有该消息id，请先检索或读取目录。';
 const length=Number(args.length??6000);if(!Number.isInteger(length)||length<1||length>12000||offset>m.content.length)return '正文offset/length无效。';
 let start=offset;if(start>0&&/[\uDC00-\uDFFF]/.test(m.content[start]))start--;
 let end=Math.min(m.content.length,start+length, start+Math.max(1,Math.floor((cap-220)/6)));
 if(end>start&&end<m.content.length&&/[\uD800-\uDBFF]/.test(m.content[end-1])){if(end-start===1)end++;else end--;}
 return bounded({messageId:m.id,role:m.role,error:!!m.error,incomplete:/\[回答已中止/.test(m.content),offset:start,totalChars:m.content.length,content:m.content.slice(start,end),nextOffset:end<m.content.length?end:null});
}
