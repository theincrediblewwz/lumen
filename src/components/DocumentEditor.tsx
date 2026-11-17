import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { documentPayload } from '../documents/client';
import type { DocumentPayload } from '../documents/core';
import { MarkdownEditor } from './MarkdownEditor';
import { EditorWindow, type EditorChoice } from './EditorWindow';

export function DocumentEditor({projectId,boardId,path,title,onClose,onSaved,choices,onChoose,onNew}:{
  projectId:string;boardId:string;path:string;title:string;onClose:()=>void;onSaved:(bytes:number)=>void;choices:EditorChoice[];onChoose:(path:string)=>void;onNew:()=>void|Promise<void>;
}) {
  const [value,setValue]=useState(''),[ready,setReady]=useState(false),[status,setStatus]=useState('正在读取文档…');
  const current=useRef(''),saved=useRef(''),scope=useRef<string>(),queue=useRef(Promise.resolve()),alive=useRef(true);
  const draftBase=`lumen.document-draft.v1:${projectId}/${boardId}/${path}`;
  const draftKey=useRef(draftBase);
  useEffect(()=>{let active=true;alive.current=true;void documentPayload(projectId,boardId,path).then(payload=>{
    if(!active)return;if(payload.attachment?.kind==='pdf')throw Error('PDF原件请在阅读器中查看，不能覆盖为Markdown。');
    scope.current=payload.scope;draftKey.current=draftBase+':'+payload.scope;saved.current=payload.markdown;
    let draft:string|null=null;try{draft=localStorage.getItem(draftKey.current);}catch{/* Native document remains readable when browser storage is unavailable. */}current.current=draft??payload.markdown;setValue(current.current);setReady(true);setStatus(draft&&draft!==payload.markdown?'已恢复未保存草稿':'已保存');
  }).catch(e=>active&&setStatus(String(e)));return()=>{active=false;alive.current=false;};},[projectId,boardId,path,draftBase]);
  const flush=useCallback(()=>{
    const run=queue.current.catch(()=>{}).then(async()=>{
      const content=current.current;if(content===saved.current)return;
      if(alive.current)setStatus('保存中…');
      try {
        await invoke<DocumentPayload>('document_update',{projectId,boardId,path,content,expectedContent:saved.current,expectedScope:scope.current});
        saved.current=content;
        if(current.current===content){try{localStorage.removeItem(draftKey.current);}catch{/* The native file has already been committed. */}}
        onSaved(new TextEncoder().encode(content).length);
        if(alive.current)setStatus(current.current===content?'已保存':'正在编辑…');
      } catch(e){if(alive.current)setStatus(`保存失败，草稿保留：${String(e)}`);throw e;}
    });queue.current=run;return run;
  },[projectId,boardId,path,draftBase,onSaved]);
  useEffect(()=>{if(!ready||value===saved.current)return;const timer=setTimeout(()=>void flush().catch(()=>{}),650);return()=>clearTimeout(timer);},[value,ready,flush]);
  useEffect(()=>{
    const close=(e:Event)=>{if(current.current!==saved.current){const run=async()=>{do{await flush();}while(current.current!==saved.current);};const pending=(e as CustomEvent<{pending?:Promise<void>[]}>)?.detail?.pending;if(pending)pending.push(run());else{e.preventDefault();void run().catch(()=>{});}}};
    window.addEventListener('lumen:before-window-close',close);return()=>window.removeEventListener('lumen:before-window-close',close);
  },[flush]);
  const change=(text:string)=>{current.current=text;setValue(text);setStatus('正在编辑…');try{localStorage.setItem(draftKey.current,text);}catch{setStatus('正在编辑，草稿暂存窗口内 · 自动保存中…');}};
  const finish=async(next:()=>void|Promise<void>)=>{
    if(!ready){next();return;}
    try{do{await flush();}while(current.current!==saved.current);await next();}catch(e){setStatus(`未能完成，编辑保留：${String(e)}`);}
  };
  return <EditorWindow title={title} status={status} path={path} choices={choices} onChoose={p=>void finish(()=>onChoose(p))} onNew={()=>void finish(onNew)} onSave={()=>void flush().catch(()=>{})} onClose={()=>void finish(onClose)}>
    {ready&&<MarkdownEditor value={value} onChange={change} onSave={()=>void flush().catch(()=>{})}/>}
  </EditorWindow>;
}
