let flushEditor: (() => Promise<void>) | undefined;
let refreshLibrary: (() => Promise<void>) | undefined;
export function registerEditorFlush(flush: () => Promise<void>): () => void { flushEditor = flush; return () => { if (flushEditor === flush) flushEditor = undefined; }; }
export function registerLibraryRefresh(refresh:()=>Promise<void>):()=>void {refreshLibrary=refresh;return()=>{if(refreshLibrary===refresh)refreshLibrary=undefined;};}
export async function requestEditorFlush(): Promise<void> {
  if (flushEditor) return flushEditor();
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve,reject)=>{
    let stop: (()=>void)|undefined;
    const timer = setTimeout(()=>{stop?.();reject(new Error('主窗口尚未确认保存，请先打开主窗口后重试'));},10000);
    void listen<{requestId:string;error?:string}>('lumen://flush-complete',ev=>{
      if(ev.payload.requestId!==requestId)return;
      clearTimeout(timer);stop?.();ev.payload.error?reject(new Error(ev.payload.error)):resolve();
    }).then(unlisten=>{stop=unlisten;return emitTo('main','lumen://flush-editor',{requestId});}).catch(error=>{clearTimeout(timer);stop?.();reject(error);});
  });
}
export async function releaseEditorLock(): Promise<void> {
  window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock',{detail:false}));
  if (!flushEditor && '__TAURI_INTERNALS__' in window) { const {emitTo}=await import('@tauri-apps/api/event');await emitTo('main','lumen://release-editor'); }
}
export async function notifyLibraryChanged(): Promise<void> {
  if(refreshLibrary){
    await refreshLibrary();
    if('__TAURI_INTERNALS__' in window){const {emit}=await import('@tauri-apps/api/event');await emit('lumen://library-changed',{fromMain:true});}
    return;
  }
  if(!('__TAURI_INTERNALS__' in window))return;
  const {emit,listen}=await import('@tauri-apps/api/event');const requestId=crypto.randomUUID();
  return new Promise<void>((resolve,reject)=>{
    let stop:(()=>void)|undefined;
    const timer=setTimeout(()=>{stop?.();reject(new Error('资料已保存，主窗口刷新未完成，请重新打开白板'));},10000);
    void listen<{requestId:string;error?:string}>('lumen://refresh-complete',event=>{
      if(event.payload.requestId!==requestId)return;clearTimeout(timer);stop?.();event.payload.error?reject(new Error(event.payload.error)):resolve();
    }).then(unlisten=>{stop=unlisten;return emit('lumen://library-changed',{requestId});}).catch(error=>{clearTimeout(timer);stop?.();reject(error);});
  });
}
