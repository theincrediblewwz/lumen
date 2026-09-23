import type { BoardFile } from '../api';
import { parseChats } from '../ai/chatStore';
import { canonicalJson, entityKey, type BlobRef, type LocalChange, type SyncEntity, type SyncState } from './core';

export type FileMap = Record<string, number[]>;
export interface DesktopLedger { version:1; state:SyncState; entities:Record<string,SyncEntity>; managed:string[]; blobs:Record<string,number[]>; retiredPaths?:string[]; pendingProjection?:{reason:string;entities:SyncEntity[]} }
export interface DesktopSnapshot { revision:string; files:FileMap; ledger:DesktopLedger|null }
export const sha256 = async (bytes:Uint8Array):Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer))].map(n=>n.toString(16).padStart(2,'0')).join('');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8',{fatal:true});
const date = '1970-01-01T00:00:00.000Z';
export const fileBytes = (value:unknown):number[] => [...encoder.encode(JSON.stringify(value,null,2))];
function parse<T>(files:FileMap,path:string,fallback:T):T { return files[path] ? JSON.parse(decoder.decode(new Uint8Array(files[path]))) as T : fallback; }
function text(v:unknown,fallback=''):string { return typeof v==='string'?v:fallback; }
function num(v:unknown,fallback=0):number { return typeof v==='number' && Number.isFinite(v)?v:fallback; }
function safeId(id:string):string { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('远端标识不能安全映射到桌面文件夹'); return id; }
function safeDoc(path:string):string { if (!/^docs\/[^/\\:]+$/.test(path) || path.includes('..')) throw new Error('远端文档路径不安全'); return path; }
export async function documentId(boardId:string,path:string):Promise<string> { return `doc_${await sha256(encoder.encode(`${boardId}\n${path}`))}`; }
const managedKinds = new Set(['projects','documents','nodes','edges','node_documents','conversations','conversation_messages','conversation_documents','reading_positions']);

/** Convert file snapshots to portable rows, overlaying only fields desktop can edit. */
export async function captureDesktop(snapshot:DesktopSnapshot):Promise<{entities:Record<string,SyncEntity>;managed:string[];changes:LocalChange[];blobs:Record<string,number[]>}> {
  const previous = snapshot.ledger?.entities ?? {};
  const entities = {...previous}; const managed = new Set<string>(); const blobStore = {...snapshot.ledger?.blobs};
  const emit = (kind:string,id:string,boardId:string,data:Record<string,unknown>,blobs?:BlobRef[]) => {
    const key = entityKey({kind,id}); const old=previous[key]?.data;
    entities[key]={id,kind,boardId,data:{...old,...data}}; managed.add(key);
    if (blobs?.length) entityBlobs.set(key,blobs);
  };
  const entityBlobs = new Map<string,BlobRef[]>();
  const index = parse<{projects:{id:string;name:string;created_at:string}[]}>(snapshot.files,'index.json',{projects:[]});
  for(const group of index.projects) {
    const project = parse<{boards:{id:string}[]}>(snapshot.files,`${group.id}/project.json`,{boards:[]});
    for(const meta of project.boards) {
      const base=`${safeId(group.id)}/${safeId(meta.id)}`;
      const board=parse<BoardFile|null>(snapshot.files,`${base}/board.json`,null);
      if(!board) throw new Error('白板目录不完整');
      const boardId=board.id; const now=board.updated_at||date;
      const oldProject=previous[entityKey({kind:'projects',id:boardId})]?.data;
      emit('projects',boardId,boardId,{id:boardId,title:board.name,source_text:oldProject?.source_text??'',created_at:board.created_at,updated_at:now,layout_direction:oldProject?.layout_direction??'vertical',topic_id:oldProject?.topic_id??null,mode:oldProject?.mode??'learning',explanation_style:oldProject?.explanation_style??'plain_language',detail_level:oldProject?.detail_level??'detailed',allow_outside_knowledge:oldProject?.allow_outside_knowledge??1,graph_kind:oldProject?.graph_kind??'free',_lumen_project:group,_lumen_viewport:board.viewport});
      const docs=new Map<string,string>();
      const addDoc=async(path:string,title:string,body:string,origin='source')=>{
        const existing=Object.values(previous).find(e=>e.kind==='documents'&&e.boardId===boardId&&e.data&&(e.data._lumen_path===path||(!e.data._lumen_path&&`docs/${e.id}.md`===path)));
        const id=existing?.id??await documentId(boardId,path); docs.set(path,id);
        const old=existing?.data??previous[entityKey({kind:'documents',id})]?.data;
        emit('documents',id,boardId,{id,project_id:boardId,path:old?.path??path,title,body,origin:old?.origin??origin,created_at:old?.created_at??board.created_at,updated_at:old?.body===body&&old?.title===title?old.updated_at??now:now,_lumen_path:path});
        return id;
      };
      for(const [path,bytes] of Object.entries(snapshot.files)) {
        if(!path.startsWith(`${base}/docs/`))continue;
        if(snapshot.ledger?.retiredPaths?.includes(path))continue;
        const local=path.slice(base.length+1);
        if(/\.(md|markdown)$/i.test(path)) {
          const ref=board.nodes.flatMap(n=>n.docs).find(d=>d.path===local);
          const previousDoc=Object.values(previous).find(e=>e.kind==='documents'&&e.boardId===boardId&&e.data&&(e.data._lumen_path===local||(!e.data._lumen_path&&`docs/${e.id}.md`===local)));
          await addDoc(local,ref?.title??text(previousDoc?.data?.title,local.split('/').pop()!),decoder.decode(new Uint8Array(bytes)));
        } else {
          // Binary assets remain byte-exact in immutable blobs. Preserve unsupported files too.
          const hash=await sha256(new Uint8Array(bytes));
          const prior=Object.values(previous).find(e=>e.kind==='source_items'&&e.boardId===boardId&&e.data&&(e.data._lumen_path===local||`docs/asset_${e.id}`===local));
          const id=prior?.id??`asset_${await sha256(encoder.encode(`${boardId}\n${local}`))}`;
          const kind=/\.pdf$/i.test(local)?'pdf':/\.(png|jpg|jpeg|webp|gif)$/i.test(local)?'image':'text';
          const mediaType=text(prior?.data?.media_type,kind==='pdf'?'application/pdf':kind==='image'?'image/'+local.split('.').pop():'application/octet-stream');
          const ref:BlobRef={sha256:hash,size:bytes.length,mediaType};
          const derivedDocument=typeof prior?.data?.derived_document_id==='string'?prior.data.derived_document_id:await addDoc(`docs/asset_note_${id}.md`,local.split('/').pop()!,`# ${local.split('/').pop()}\n\n原始附件已保存。`);
          blobStore[hash]=bytes;
          emit('source_items',id,boardId,{id,project_id:boardId,title:prior?.data?.title??local.split('/').pop(),kind:prior?.data?.kind??kind,original_name:prior?.data?.original_name??local.split('/').pop(),media_type:mediaType,source_url:prior?.data?.source_url??null,content_hash:hash,byte_size:bytes.length,extraction_status:prior?.data?.extraction_status??'ready',extraction_error:prior?.data?.extraction_error??null,derived_document_id:derivedDocument,asset_blob:ref,created_at:prior?.data?.created_at??board.created_at,updated_at:prior?.data?.content_hash===hash?prior.data.updated_at:now,_lumen_path:local},[ref]);
        }
      }
      for(let i=0;i<board.nodes.length;i++) {
        const node=board.nodes[i];
        const primary=node.docs[0]?.path;
        const docId=primary?docs.get(primary):await addDoc(`docs/node_${safeId(node.id)}.md`,node.title,node.summary??'','learner');
        if(!docId)throw new Error(`节点文档缺失：${node.title}`);
        const old=previous[entityKey({kind:'nodes',id:node.id})]?.data;
        emit('nodes',node.id,boardId,{id:node.id,project_id:boardId,title:node.title,subtitle:node.summary??'',x:node.x,y:node.y,importance:old?.importance??5,status:old?.status??'learning',sort_order:old?.sort_order??i,document_id:docId,_lumen_w:node.w,_lumen_color:node.color??null,_lumen_created_at:node.created_at,_lumen_updated_at:node.updated_at});
        for(const [sort,ref] of node.docs.entries()) {
          const document_id=docs.get(ref.path); if(!document_id)throw new Error('节点文档未找到');
          const prior=Object.values(previous).find(e=>e.kind==='node_documents'&&e.data?.node_id===node.id&&e.data?.document_id===document_id);
          const id=prior?.id??`link-${node.id}-${document_id}`;
          emit('node_documents',id,boardId,{id,node_id:node.id,document_id,sort_order:sort});
        }
      }
      for(const edge of board.edges) {
        const old=previous[entityKey({kind:'edges',id:edge.id})]?.data;
        const docId=typeof old?.document_id==='string'&&entities[entityKey({kind:'documents',id:old.document_id})]?.data?old.document_id:await addDoc(`docs/edge_${safeId(edge.id)}.md`,edge.label??'关系',edge.label??'','learner');
        emit('edges',edge.id,boardId,{id:edge.id,project_id:boardId,source_id:edge.from,target_id:edge.to,relation:old?.relation??'support',importance:old?.importance??5,document_id:docId,relation_kind:old?.relation_kind??'related',directed:edge.directed?1:0,label:edge.label??null,_lumen_created_at:edge.created_at});
      }
      const chats=parseChats(snapshot.files[`${base}/chats.json`]?decoder.decode(new Uint8Array(snapshot.files[`${base}/chats.json`])):'');
      for(const conversation of chats.conversations) {
        const old=previous[entityKey({kind:'conversations',id:conversation.id})]?.data;
        emit('conversations',conversation.id,boardId,{id:conversation.id,project_id:boardId,node_id:old?.node_id??null,title:conversation.title,created_at:conversation.createdAt,updated_at:conversation.updatedAt});
        for(const [ordinal,m] of conversation.messages.entries()) {
          const id=m.id??`${conversation.id}_m_${ordinal}`;
          const oldMessage=previous[entityKey({kind:'conversation_messages',id})]?.data;
          emit('conversation_messages',id,boardId,{id,conversation_id:conversation.id,role:m.role,body:m.content,status:oldMessage?.body===m.content?oldMessage.status:m.error?'failed':'complete',ordinal,request_id:oldMessage?.request_id??null,actual_model:oldMessage?.actual_model??null,created_at:m.at,updated_at:oldMessage?.body===m.content?oldMessage.updated_at??m.at:m.at});
        }
      }
      for(const capture of parse<Record<string,unknown>[]>(snapshot.files,`${base}/chat-captures.json`,[])) {
        if(!board.nodes.some(n=>n.id===capture.node_id))continue;
        const document_id=docs.get(text(capture.document_path)); if(!document_id)continue;
        const {document_path:_,...data}=capture;
        emit('conversation_documents',text(capture.id),boardId,{...data,document_id});
      }
      for(const position of parse<Record<string,unknown>[]>(snapshot.files,`${base}/reading-positions.json`,[])){
        const document_id=docs.get(text(position.path));if(!document_id)continue;
        const existing=Object.values(previous).find(e=>e.kind==='reading_positions'&&e.data?.document_id===document_id);
        const id=existing?.id??document_id;
        emit('reading_positions',id,boardId,{id,document_id,anchor:position.anchor??null,ratio:num(position.ratio),updated_at:text(position.updated_at,now)});
      }
    }
  }
  for(const key of snapshot.ledger?.managed??[]) {
    if(!managed.has(key)&&previous[key]?.data)entities[key]={...previous[key],data:null};
  }
  const changes=Object.entries(entities).filter(([key,value])=>canonicalJson(value)!==canonicalJson(previous[key]??null)).map(([key,entity])=>({entity,blobs:entityBlobs.get(key)}));
  return {entities,managed:[...managed],changes,blobs:blobStore};
}

/** Projection never erases unrecognized portable rows. Deleted files remain recoverable on disk. */
export function projectDesktop(entities:Record<string,SyncEntity>,blobs:Record<string,number[]>):FileMap {
  const live=Object.values(entities).filter(e=>e.data!==null);
  const boardIds=new Set(live.filter(e=>e.kind==='projects').map(e=>e.id));
  if(live.some(e=>e.boardId!==null&&!boardIds.has(e.boardId)))throw new Error('删除白板与另一设备的内容更改冲突，已保留本机资料');
  const files:FileMap={};
  const groups=new Map<string,{id:string;name:string;created_at:string;boards:{id:string;name:string;updated_at:string}[]}>();
  for(const entity of live.filter(e=>e.kind==='projects')) {
    const d=entity.data!; const boardId=safeId(entity.id);
    const original=d._lumen_project as {id?:string;name?:string;created_at?:string}|undefined;
    const groupId=safeId(original?.id??'synced');
    if(!groups.has(groupId))groups.set(groupId,{id:groupId,name:original?.name??'同步学习',created_at:original?.created_at??text(d.created_at,date),boards:[]});
    groups.get(groupId)!.boards.push({id:boardId,name:text(d.title,'白板'),updated_at:text(d.updated_at,date)});
    const base=`${groupId}/${boardId}`;
    const rows=(kind:string)=>live.filter(e=>e.kind===kind&&e.boardId===boardId);
    const docs=new Map<string,{path:string;title:string;bytes:number}>();
    for(const doc of rows('documents')) {
      const value=doc.data!; const path=safeDoc(text(value._lumen_path,`docs/${safeId(doc.id)}.md`));
      const bytes=[...encoder.encode(text(value.body))];files[`${base}/${path}`]=bytes;
      docs.set(doc.id,{path,title:text(value.title,'文档'),bytes:bytes.length});
    }
    const nodes=rows('nodes').map(e=>{
      const n=e.data!; const links=rows('node_documents').filter(l=>l.data!.node_id===e.id).sort((a,b)=>num(a.data!.sort_order)-num(b.data!.sort_order));
      if(!docs.has(text(n.document_id))||links.some(l=>!docs.has(text(l.data!.document_id))))throw new Error('节点引用的文档尚未到齐，保留当前白板');
      const ids=[text(n.document_id),...links.map(l=>text(l.data!.document_id))];
      const refs=[...new Set(ids)].map(id=>docs.get(id)).filter((d):d is {path:string;title:string;bytes:number}=>!!d);
      return {id:e.id,title:text(n.title),summary:text(n.subtitle),x:num(n.x),y:num(n.y),w:num(n._lumen_w,240),color:n._lumen_color??null,docs:refs,created_at:text(n._lumen_created_at,text(d.created_at,date)),updated_at:text(n._lumen_updated_at,text(d.updated_at,date))};
    });
    const nodeIds=new Set(nodes.map(n=>n.id));
    if(rows('node_documents').some(e=>!nodeIds.has(text(e.data!.node_id))||!docs.has(text(e.data!.document_id))))throw new Error('文档关联的节点尚未到齐，已保留本机资料');
    if(rows('edges').some(e=>!nodeIds.has(text(e.data!.source_id))||!nodeIds.has(text(e.data!.target_id))||!docs.has(text(e.data!.document_id))))throw new Error('连线引用尚未到齐，保留当前白板');
    const conversationIds=new Set(rows('conversations').map(e=>e.id));
    if(rows('conversation_messages').some(e=>!conversationIds.has(text(e.data!.conversation_id))))throw new Error('消息来源对话尚未到齐，已保留本机资料');
    if(rows('conversations').some(e=>e.data!.node_id&&!nodeIds.has(text(e.data!.node_id))))throw new Error('对话的来源节点尚未到齐，已保留本机资料');
    if(rows('conversation_documents').some(e=>!docs.has(text(e.data!.document_id))||!nodeIds.has(text(e.data!.node_id))||(e.data!.conversation_id&&!conversationIds.has(text(e.data!.conversation_id)))))throw new Error('对话文档的来源尚未到齐，已保留本机资料');
    if(rows('reading_positions').some(e=>!docs.has(text(e.data!.document_id))))throw new Error('阅读位置的文档尚未到齐，已保留本机资料');
    if(rows('source_items').some(e=>!docs.has(text(e.data!.derived_document_id))))throw new Error('附件的说明文档尚未到齐，已保留本机资料');
    const edges=rows('edges').filter(e=>nodeIds.has(text(e.data!.source_id))&&nodeIds.has(text(e.data!.target_id))).map(e=>({id:e.id,from:text(e.data!.source_id),to:text(e.data!.target_id),directed:e.data!.directed!==0,label:e.data!.label??null,created_at:text(e.data!._lumen_created_at,text(d.created_at,date))}));
    files[`${base}/board.json`]=fileBytes({version:1,id:boardId,name:text(d.title),projectId:groupId,created_at:text(d.created_at,date),updated_at:text(d.updated_at,date),viewport:d._lumen_viewport??{x:0,y:0,zoom:1},nodes,edges});
    const conversations=rows('conversations').sort((a,b)=>text(a.data!.created_at).localeCompare(text(b.data!.created_at))).map(e=>({id:e.id,title:text(e.data!.title),createdAt:text(e.data!.created_at),updatedAt:text(e.data!.updated_at),messages:rows('conversation_messages').filter(m=>m.data!.conversation_id===e.id).sort((a,b)=>num(a.data!.ordinal)-num(b.data!.ordinal)).map(m=>({id:m.id,role:m.data!.role,content:text(m.data!.body),error:m.data!.status==='failed',at:text(m.data!.created_at)}))}));
    files[`${base}/chats.json`]=fileBytes({version:1,conversations});
    files[`${base}/chat-captures.json`]=fileBytes(rows('conversation_documents').map(e=>({...e.data,document_path:docs.get(text(e.data!.document_id))?.path??''})));
    files[`${base}/reading-positions.json`]=fileBytes(rows('reading_positions').filter(e=>docs.has(text(e.data!.document_id))).map(e=>({...e.data,path:docs.get(text(e.data!.document_id))!.path})));
    for(const asset of rows('source_items')) {
      const ref=asset.data!.asset_blob as BlobRef|undefined;
      if(!ref)continue;
      const bytes=blobs[ref.sha256]; if(!bytes)throw new Error('附件尚未完整下载，保持当前文档');
      const path=safeDoc(text(asset.data!._lumen_path,`docs/asset_${safeId(asset.id)}`));
      files[`${base}/${path}`]=bytes;
    }
  }
  files['index.json']=fileBytes({version:1,projects:[...groups.values()].map(({boards:_,...p})=>p)});
  for(const group of groups.values())files[`${group.id}/project.json`]=fileBytes({version:1,...group,updated_at:group.boards.reduce((latest,b)=>b.updated_at>latest?b.updated_at:latest,date)});
  return files;
}

export function managedKeys(entities:Record<string,SyncEntity>):string[] { return Object.entries(entities).filter(([,e])=>e.data&&(managedKinds.has(e.kind)||(e.kind==='source_items'&&e.data._lumen_path))).map(([key])=>key); }

export function localBranches(state:SyncState,previous:Record<string,SyncEntity>,changes:LocalChange[]):LocalChange[] {
  return changes.map(change=>{
    const key=entityKey(change.entity);const heads=state.heads[key]??[];
    return {...change,parents:heads.filter(head=>canonicalJson(state.commits[head].commit.changes.find(c=>entityKey(c.entity)===key)?.entity??null)===canonicalJson(previous[key]??null))};
  });
}
export function stateProjection(state:SyncState,previous:Record<string,SyncEntity>):Record<string,SyncEntity> {
  const entities={...previous};
  for(const [key,heads] of Object.entries(state.heads))if(heads.length===1){const entity=state.commits[heads[0]].commit.changes.find(c=>entityKey(c.entity)===key)?.entity;if(entity)entities[key]=entity;}
  return entities;
}
