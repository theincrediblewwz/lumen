import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { api, type BoardFile } from '../api';
import { requestEditorFlush, releaseEditorLock, notifyLibraryChanged } from '../sync/events';
export type WritePolicy={enabled:boolean;revision:number;keep:number};
export type PolicySnapshot={policy:WritePolicy;scope:string|null};
export type OperationBatch={schema:'lumen.board-operations/v1';operations:Record<string,unknown>[]};
export type OperationResult={board:BoardFile;summary:string;backup:string;reused:boolean;warning?:string|null;documents?:string[];nodes?:Record<string,string>};
export const loadWritePolicy=()=>invoke<PolicySnapshot>('board_write_policy_get');
export const saveWritePolicy=(policy:WritePolicy,enabled:boolean,keep:number)=>invoke<WritePolicy>('board_write_policy_set',{enabled,keep,expectedRevision:policy.revision});
export async function exportMarkdown(projectId:string,boardId:string,path:string,title:string):Promise<string|null>{
 const destination=await save({title:'导出 Markdown',defaultPath:title.replace(/[<>:"/\\|?*\r\n]/g,'_').slice(0,120)+'.md',filters:[{name:'Markdown',extensions:['md']}]});
 if(!destination)return null;
 await invoke('doc_export_markdown',{projectId,boardId,path,destination});return destination;
}
/** The editor is locked only for the local atomic commit, never while waiting for the model. */
export function sameBoardContent(a:BoardFile,b:BoardFile):boolean {
 const content=(board:BoardFile)=>{
  const {_disk_revision:transport,viewport,updated_at:updated,...business}=board;
  void transport;void viewport;void updated;
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,stable(v)])):value;
  return JSON.stringify(stable(business));
 };
 return content(a)===content(b);
}
export async function loadFlushedBoard(projectId:string,boardId:string):Promise<BoardFile>{
 let locked=false;
 try{await requestEditorFlush();locked=true;return await api.boardLoad(projectId,boardId);}
 finally{if(locked)await releaseEditorLock().catch(()=>{});}
}
export async function commitBoardOperations(projectId:string,boardId:string,batch:OperationBatch,requestId:string,permission:PolicySnapshot,baseline:BoardFile,cancelled:()=>boolean=()=>false):Promise<OperationResult>{
 let locked=false;
 try{await requestEditorFlush();locked=true;
 if(cancelled())throw new Error('请求已取消，本批未写入');
 const latest=await api.boardLoad(projectId,boardId);
 if(!sameBoardContent(baseline,latest))throw new Error('白板内容已被修改，请基于最新内容重新发送');
 if(cancelled())throw new Error('请求已取消，本批未写入');
 // Only presentation changes may rebase. Native raw-file CAS still detects a
 // writer racing this fresh read; never replace this with unconditional writes.
 const expectedRevision=latest._disk_revision??'';
 const result=await invoke<OperationResult>('board_operations_apply',{projectId,boardId,batch,requestId,expectedScope:permission.scope,grantRevision:permission.policy.revision,expectedRevision});
 try{await notifyLibraryChanged();}catch{result.warning='已保存，主窗口刷新未完成，请重新打开白板。';}return result;
 }finally{if(locked)await releaseEditorLock().catch(()=>{});}
}
export type BoardBackup={file:string;created_at:string;reason:string;bytes:number};
export const listBoardBackups=(projectId:string,boardId:string)=>invoke<BoardBackup[]>('board_backups_list',{projectId,boardId});
export async function restoreBoardBackup(projectId:string,boardId:string,file:string,expectedScope:string|null):Promise<BoardFile>{
 let locked=false;
 try{await requestEditorFlush();locked=true;const current=await api.boardLoad(projectId,boardId);const board=await invoke<BoardFile>('board_backup_restore',{projectId,boardId,file,expectedScope,expectedRevision:current._disk_revision});await notifyLibraryChanged();return board;}
 finally{if(locked)await releaseEditorLock().catch(()=>{});}
}
