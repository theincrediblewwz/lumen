import { invoke } from '@tauri-apps/api/core';
import { captureDesktop, projectDesktop, managedKeys, localBranches, stateProjection, sha256, type DesktopSnapshot, type DesktopLedger, type FileMap } from './adapter';
import { canonicalJson, createSyncState, createWebDavTransport, entityKey, getConflicts, parseSyncState, queueLocalChanges, synchronize, type BlobRef, type SyncConflict } from './core';
import { notifyLibraryChanged, requestEditorFlush, releaseEditorLock } from './events';

export interface SyncSettings { enabled:boolean;endpoint:string;username:string;libraryId:string;deviceId:string }
export interface SyncStatus { busy:boolean;message:string;conflicts:SyncConflict[];pendingProjection?:DesktopLedger['pendingProjection'] }
let status:SyncStatus={busy:false,message:'同步未启用',conflicts:[]};
const listeners=new Set<(value:SyncStatus)=>void>();
const publish=(patch:Partial<SyncStatus>)=>{status={...status,...patch};listeners.forEach(fn=>fn(status));};
export const getSyncStatus=()=>status;
export const subscribeSync=(fn:(value:SyncStatus)=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const loadSyncSettings=()=>invoke<SyncSettings>('sync_settings_get');
export async function saveSyncSettings(config:SyncSettings,password:string):Promise<SyncSettings> {
  const saved=await invoke<SyncSettings>('sync_settings_set',{config,password:password||null});
  publish({message:saved.enabled?'等待同步':'同步已暂停'});
  return saved;
}

/** Native credentials remain in Rust; JS receives only the bounded response bytes. */
const nativeFetch:typeof fetch=async(input,init)=>{
  if(init?.signal?.aborted)throw new Error('同步已取消');
  const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
  const body=init?.body?Array.from(new Uint8Array(await new Response(init.body).arrayBuffer())):[];
  const result=await invoke<{status:number;headers:Record<string,string>;body:number[]}>('sync_http',{url:String(input),method:init?.method??'GET',headers,body});
  if(init?.signal?.aborted)throw new Error('同步已取消');
  return new Response([101,204,205,304].includes(result.status)?null:new Uint8Array(result.body),{status:result.status,headers:result.headers});
};

let running:Promise<void>|null=null;
export function runDesktopSync():Promise<void> {
  if(running)return running;
  running=run().finally(()=>{running=null;publish({busy:false});});
  return running;
}
async function run():Promise<void> {
  let editorLocked=false;
  try {
    const config=await loadSyncSettings();
    if(!config.enabled){publish({message:'同步已暂停'});return;}
    publish({busy:true,message:'正在同步…'});
    await requestEditorFlush();
    editorLocked=true;
    window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock',{detail:true}));
    const snapshot=await invoke<DesktopSnapshot>('sync_snapshot');
    let revision=snapshot.revision;
    const captured=await captureDesktop(snapshot);
    let state=snapshot.ledger?await parseSyncState(JSON.stringify(snapshot.ledger.state),sha256):createSyncState(config.libraryId,config.deviceId);
    if(state.libraryId!==config.libraryId||state.deviceId!==config.deviceId)throw new Error('同步身份与本地记录不一致，请保留目录并检查设置');
    // One local transaction preserves all FK-related row changes in a single commit.
    // Core bounds deliberately reject oversized captures rather than half-publishing a graph.
    if(captured.changes.length)state=await queueLocalChanges(state,localBranches(state,snapshot.ledger?.entities??{},captured.changes),sha256);
    let ledger:DesktopLedger={version:1,state,entities:captured.entities,managed:captured.managed,blobs:captured.blobs,retiredPaths:snapshot.ledger?.retiredPaths??[],...(snapshot.ledger?.pendingProjection?{pendingProjection:snapshot.ledger.pendingProjection}:{})};
    const persist=async(next:DesktopLedger,files:FileMap)=>{
      revision=await invoke<string>('sync_apply',{expectedRevision:revision,files,ledger:next});
      ledger=next;
    };
    await persist(ledger,{}); // durable outbox before any network request
    await releaseEditorLock();editorLocked=false; // no UI lock during network IO
    const result=await synchronize({state,sha256,transport:createWebDavTransport({endpoint:config.endpoint,fetch:nativeFetch}),readBlob:async ref=>{
      const bytes=ledger.blobs[ref.sha256];if(!bytes)throw new Error('本地附件缺失，待修复后重试');return new Uint8Array(bytes);
    },apply:async application=>{
      await requestEditorFlush();editorLocked=true;
      try {
      const entities=application.commit?stateProjection(application.state,ledger.entities):ledger.entities;
      const blobs={...ledger.blobs};for(const blob of application.blobs)blobs[blob.ref.sha256]=Array.from(blob.bytes);
      let files:FileMap={};
      if(application.commit){
        try{files=projectDesktop(entities,blobs);}
        catch(error){
          const pendingProjection={reason:String(error),entities:Object.entries(entities).filter(([key,entity])=>canonicalJson(entity)!==canonicalJson(ledger.entities[key]??null)).map(([,entity])=>entity)};
          await persist({...ledger,state:application.state,blobs,pendingProjection},{});
          publish({conflicts:application.conflicts,pendingProjection});return;
        }
      }
      const retiredPaths=application.commit?[...new Set([...(ledger.retiredPaths??[]),...Object.keys(projectDesktop(ledger.entities,ledger.blobs)).filter(path=>!files[path])])].filter(path=>!files[path]):ledger.retiredPaths;
      const next={...ledger,state:application.state,entities,blobs,managed:managedKeys(entities),retiredPaths};
      if(application.commit)delete next.pendingProjection;
      await persist(next,files);
      if(application.commit)await notifyLibraryChanged();
      publish({conflicts:application.conflicts,pendingProjection:next.pendingProjection});
      }finally{await releaseEditorLock();editorLocked=false;}
    }});
    const conflicts=getConflicts(result.state);
    publish({conflicts,pendingProjection:ledger.pendingProjection,message:ledger.pendingProjection?'存在删除或引用冲突，已保留当前资料，请在设置中处理':conflicts.length?`有 ${conflicts.length} 处内容需要选择版本`:result.pending.length?`附件或前序更改未到齐，保留 ${result.pending.length} 项等待重试`:`已同步 · ${new Date().toLocaleTimeString()}（上传 ${result.pushed}，接收 ${result.pulled}）`});
  } catch(error) {
    publish({message:`同步未完成：${String(error)}。本地内容与待发送记录已保留。`});
    throw error;
  } finally {
    if(editorLocked)await releaseEditorLock();
  }
}

export async function keepCurrentProjection():Promise<void>{
  if(running)await running;
  await requestEditorFlush();
  try{
    const snapshot=await invoke<DesktopSnapshot>('sync_snapshot');const old=snapshot.ledger;
    if(!old?.pendingProjection)throw new Error('没有待处理的引用冲突');
    const changes=old.pendingProjection.entities.map(incoming=>{
      const entity=old.entities[entityKey(incoming)]??{...incoming,data:null};
      const ref=entity.data?.asset_blob as BlobRef|undefined;
      return {entity,...(ref?{blobs:[ref]}:{})};
    });
    const state=await queueLocalChanges(old.state,changes,sha256);
    const ledger={...old,state};delete ledger.pendingProjection;
    await invoke('sync_apply',{expectedRevision:snapshot.revision,files:{},ledger});
    publish({pendingProjection:undefined,conflicts:getConflicts(state),message:'已保留当前电脑版本，原远端版本仍保存在同步历史中'});
  }finally{await releaseEditorLock();}
  void runDesktopSync().catch(()=>{});
}

export async function resolveDesktopConflict(conflict:SyncConflict,revisionToKeep:string):Promise<void> {
  if(running)await running;
  await requestEditorFlush();
  try {
  const snapshot=await invoke<DesktopSnapshot>('sync_snapshot');
  if(!snapshot.ledger)throw new Error('同步状态不存在');
  const chosen=conflict.versions.find(v=>v.revision===revisionToKeep);if(!chosen)throw new Error('选择的版本不存在');
  const current=getConflicts(snapshot.ledger.state).find(c=>c.key===conflict.key);
  if(!current||JSON.stringify(current.versions.map(v=>v.revision))!==JSON.stringify(conflict.versions.map(v=>v.revision)))throw new Error('冲突版本已变化，请刷新后选择');
  const state=await queueLocalChanges(snapshot.ledger.state,[{entity:chosen.entity,blobs:chosen.blobs}],sha256);
  const entities={...snapshot.ledger.entities,[conflict.key]:chosen.entity};
  const files=projectDesktop(entities,snapshot.ledger.blobs);
  const retiredPaths=[...new Set([...(snapshot.ledger.retiredPaths??[]),...Object.keys(projectDesktop(snapshot.ledger.entities,snapshot.ledger.blobs)).filter(path=>!files[path])])].filter(path=>!files[path]);
  const ledger={...snapshot.ledger,state,entities,managed:managedKeys(entities),retiredPaths};
  await invoke('sync_apply',{expectedRevision:snapshot.revision,files,ledger});
  publish({conflicts:getConflicts(state),message:'已保存选择，等待同步'});
  await notifyLibraryChanged();
  } finally {await releaseEditorLock();}
  void runDesktopSync().catch(()=>{});
}

export function startForegroundSync():()=>void {
  const run=()=>{if(document.visibilityState==='visible')void runDesktopSync().catch(()=>{});};
  const timer=setInterval(run,30000);window.addEventListener('focus',run);window.addEventListener('online',run);document.addEventListener('visibilitychange',run);
  run();return()=>{clearInterval(timer);window.removeEventListener('focus',run);window.removeEventListener('online',run);document.removeEventListener('visibilitychange',run);};
}
