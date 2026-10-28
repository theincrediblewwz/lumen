import { loadBoardChats, type StoredMessage } from './chatStore';
import { prefixFingerprint } from './chatMemory';
export type GenerationLease={token?:string;release:()=>Promise<void>;validate:()=>Promise<void>};
export async function claimGeneration(projectId:string,boardId:string,conversationId:string,messages:StoredMessage[],expectedScope?:string):Promise<GenerationLease>{
 const baseline=await prefixFingerprint(messages,{index:messages.length,offset:0});
 if('__TAURI_INTERNALS__' in window){
  if(!expectedScope)throw Error('原始对话目录未确认。');
  const {invoke}=await import('@tauri-apps/api/core');const args={projectId,boardId,conversationId,expectedScope,token:crypto.randomUUID(),baseline};
  await invoke('chat_generation_claim',args);return {token:args.token,release:()=>invoke('chat_generation_release',args),validate:()=>invoke('chat_generation_validate',args)};
 }
 if(!navigator.locks)throw Error('当前浏览器不支持安全的跨窗口续聊，请使用桌面应用。');
 return new Promise((resolve,reject)=>{
  void navigator.locks.request(`lumen.generation.${projectId}.${boardId}.${conversationId}`,{ifAvailable:true},async lock=>{
   if(!lock)throw Error('这段对话已在另一个窗口运行，请等它保存完成后重新打开；当前输入已保留。');
   const chats=await loadBoardChats(projectId,boardId);const latest=chats.conversations.find(c=>c.id===conversationId)?.messages??[];
   if(await prefixFingerprint(latest,{index:latest.length,offset:0})!==baseline)throw Error('原始对话已更新，请重新打开后发送；当前输入已保留。');
   await new Promise<void>(release=>resolve({release:async()=>release(),validate:async()=>{}}));
  }).catch(reject);
 });
}
