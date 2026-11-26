let flushEditor: (() => Promise<void>) | undefined;
let refreshLibrary: (() => Promise<void>) | undefined;
let remoteLockId: string | undefined;
export interface EditorFlushRequest { requestId: string; deadline: number }
export function registerEditorFlush(flush: () => Promise<void>): () => void { flushEditor = flush; return () => { if (flushEditor === flush) flushEditor = undefined; }; }
export function registerLibraryRefresh(refresh:()=>Promise<void>):()=>void {refreshLibrary=refresh;return()=>{if(refreshLibrary===refresh)refreshLibrary=undefined;};}
export async function requestEditorFlush(): Promise<void> {
  if (flushEditor) return flushEditor();
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = crypto.randomUUID();
  const deadline = Date.now() + 10_000;
  let sent = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let stop: (() => void) | undefined;
      let settled = false;
      const timedOut = () => new Error('主窗口尚未确认保存，请先打开主窗口后重试');
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop?.();
        if (error !== undefined) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(timedOut()), 10_000);
      void listen<{requestId:string;error?:string}>('lumen://flush-complete', ({ payload }) => {
        if (payload.requestId !== requestId) return;
        if (Date.now() >= deadline) finish(timedOut());
        else finish(payload.error ? new Error(payload.error) : undefined);
      }).then(unlisten => {
        if (settled) { unlisten(); return; }
        stop = unlisten;
        sent = true;
        return emitTo('main', 'lumen://flush-editor', { requestId, deadline } satisfies EditorFlushRequest);
      }).catch(error => finish(error ?? timedOut()));
    });
  } catch (error) {
    // A request may have reached the main window before its acknowledgement timed out.
    if (sent) void emitTo('main', 'lumen://release-editor', { requestId }).catch(() => {});
    throw error;
  }
  remoteLockId = requestId;
}
export async function releaseEditorLock(): Promise<void> {
  window.dispatchEvent(new CustomEvent('lumen:sync-edit-lock',{detail:false}));
  const requestId = remoteLockId;
  if (!requestId) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', 'lumen://release-editor', { requestId });
  if (remoteLockId === requestId) remoteLockId = undefined;
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
