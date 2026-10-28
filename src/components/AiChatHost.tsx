import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPane, type Props } from './AiChat';
import { newId } from '../ai/chatStore';
import { OPEN_CONVERSATION_EVENT, type OpenAiArgs } from '../ai/aiWindow';
import {restoreConversation,type DeletedConversation} from '../ai/historyActions';

export interface SessionStatus { conversationId:string; title:string; working:boolean; retained:boolean; progress:string; failed:boolean; initialized:boolean; navigationLocked:boolean }
interface Slot { key:string; conversationId?:string; freshId?:string; messageIds?:string[];history?:boolean }
/** Each running conversation owns its mounted controller, stream and save queue. */
export function AiChat(props:Props){
  const first=useRef<Slot>({key:newId(),conversationId:props.conversationId,messageIds:props.messageIds});
  const [slots,setSlots]=useState<Slot[]>([first.current]);
  const [active,setActive]=useState(first.current.key);
  const [lastDeleted,setLastDeleted]=useState<DeletedConversation>();
  const [restoring,setRestoring]=useState(false),[restoreError,setRestoreError]=useState('');
  const deletedRef=useRef(lastDeleted);deletedRef.current=lastDeleted;
  const [states,setStates]=useState<Record<string,SessionStatus>>({});
  const stateRef=useRef(states);stateRef.current=states;
  const slotRef=useRef(slots);slotRef.current=slots;
  const activeRef=useRef(active);activeRef.current=active;
  const visible=props.visible!==false;
  const status=useCallback((key:string,next:SessionStatus)=>setStates(prev=>JSON.stringify(prev[key])===JSON.stringify(next)?prev:{...prev,[key]:next}),[]);
  const navigate=useCallback((id?:string,messageIds?:string[])=>{
    if(stateRef.current[activeRef.current]?.navigationLocked)return;
    const existing=id?slotRef.current.find(s=>s.conversationId===id||stateRef.current[s.key]?.conversationId===id):undefined;
    if(existing){setSlots(prev=>prev.map(s=>s.key===existing.key?{...s,messageIds}:s));setActive(existing.key);return;}
    const key=newId();setSlots(prev=>[...prev,{key,conversationId:id,freshId:id?undefined:newId(),messageIds}]);setActive(key);
  },[]);
  const removed=useCallback((item:DeletedConversation)=>{
    if(item.receipt){setLastDeleted(item);setRestoreError('');}
    const matching=slotRef.current.filter(s=>s.conversationId===item.conversationId||stateRef.current[s.key]?.conversationId===item.conversationId);
    if(!matching.length)return;
    const keys=new Set(matching.map(s=>s.key));
    stateRef.current=Object.fromEntries(Object.entries(stateRef.current).filter(([key])=>!keys.has(key)));
    setStates(prev=>Object.fromEntries(Object.entries(prev).filter(([key])=>!keys.has(key))));
    let next=slotRef.current.filter(s=>!matching.includes(s));
    if(matching.some(s=>s.key===activeRef.current)){const fresh={key:newId(),freshId:newId(),history:true};next=[...next,fresh];activeRef.current=fresh.key;setActive(fresh.key);}
    slotRef.current=next;setSlots(next);
  },[]);
  useEffect(()=>{
    setSlots(prev=>prev.filter(s=>s.key===active||!states[s.key]?.initialized||states[s.key]?.retained));
  },[active,states]);
  useEffect(()=>{if(props.retentionKey)props.onRetentionChange?.(props.retentionKey,slots.some(s=>!states[s.key]?.initialized||states[s.key]?.retained));},[slots,states,props.retentionKey,props.onRetentionChange]);
  // Sidebar/source-link navigation goes through the owner, never through a live controller.
  const requestKey=props.messageIds?.join(',')??'';
  const previousRequest=useRef(`${props.conversationId??''}:${requestKey}`);
  useEffect(()=>{const next=`${props.conversationId??''}:${requestKey}`;if(next!==previousRequest.current){previousRequest.current=next;if(props.conversationId)navigate(props.conversationId,props.messageIds);}},[props.conversationId,requestKey,navigate]);
  useEffect(()=>{
    let disposed=false;const stops:Array<()=>void>=[];
    const open=(target:OpenAiArgs)=>{if(target.projectId&&target.projectId!==props.projectId)return;if(target.boardId===props.boardId&&target.conversationId)navigate(target.conversationId,target.messageIds);};
    const local=(event:Event)=>open((event as CustomEvent<OpenAiArgs>).detail);
    window.addEventListener(OPEN_CONVERSATION_EVENT,local);
    if('__TAURI_INTERNALS__' in window)void import('@tauri-apps/api/event').then(async({listen})=>{const stop=await listen<OpenAiArgs>('lumen://open-conversation',e=>open(e.payload));if(disposed)stop();else stops.push(stop);});
    return()=>{disposed=true;window.removeEventListener(OPEN_CONVERSATION_EVENT,local);stops.forEach(stop=>stop());};
  },[props.projectId,props.boardId,navigate]);
  // Hiding a retained overlay is safe; destroying the containing WebView is not.
  useEffect(()=>{props.registerLeaveGuard?.(()=>true);return()=>props.registerLeaveGuard?.(null);},[props.registerLeaveGuard]);
  useEffect(()=>{
    const beforeClose=(event:Event)=>{if(slotRef.current.some(slot=>stateRef.current[slot.key]?.retained))event.preventDefault();};
    window.addEventListener('lumen:before-window-close',beforeClose);
    let disposed=false;let unlisten:(()=>void)|undefined;
    if(props.standalone&&'__TAURI_INTERNALS__' in window)void import('@tauri-apps/api/window').then(async({getCurrentWindow})=>{
      const win=getCurrentWindow();const stop=await win.onCloseRequested(event=>{if(slotRef.current.some(slot=>stateRef.current[slot.key]?.retained)){event.preventDefault();void win.hide().catch(()=>{});}});if(disposed)stop();else unlisten=stop;
    });
    return()=>{disposed=true;unlisten?.();window.removeEventListener('lumen:before-window-close',beforeClose);};
  },[props.standalone]);
  const signals=Object.fromEntries(Object.values(states).map(s=>[s.conversationId,s]));
  const background=Object.entries(states).filter(([key,s])=>key!==active&&slots.some(slot=>slot.key===key)&&s.retained);
  return <div className="ai-session-host" style={{height:'100%',display:'flex',flexDirection:'column'}}>
    {lastDeleted&&<div className="ai-history-notice" role="status"><span>{restoreError||'对话已删除，已保存的笔记仍保留。'}</span><button className="ai-btn-secondary" disabled={restoring} onClick={()=>{setRestoring(true);void restoreConversation(props.projectId,props.boardId,lastDeleted).then(()=>{setLastDeleted(current=>current?.receipt===lastDeleted.receipt?undefined:current);setRestoreError('');}).catch(e=>{if(deletedRef.current?.receipt===lastDeleted.receipt)setRestoreError(String(e));}).finally(()=>setRestoring(false));}}>撤销删除</button></div>}
    {background.length>0&&<div className="ai-background-tasks" role="status">{background.map(([key,s])=><button className="ai-background-task" key={key} onClick={()=>setActive(key)} title={s.progress}>{s.working&&<span className="ai-tool-spinner"/>}<span>{s.title||'对话'} · {s.failed?'保存未完成':s.progress||(s.working?'运行中':'草稿')}</span></button>)}</div>}
    {slots.map(slot=><div key={slot.key} hidden={slot.key!==active} style={slot.key===active?{flex:1,minHeight:0}:undefined}><ChatPane {...props} conversationId={slot.conversationId} messageIds={slot.messageIds} freshId={slot.freshId} initialHistory={slot.history} onConversationDeleted={removed} paneKey={slot.key} visible={visible&&slot.key===active} onSessionStatus={status} onNavigate={navigate} sessionSignals={signals}/></div>)}
  </div>;
}
