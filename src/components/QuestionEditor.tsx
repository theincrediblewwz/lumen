import { useState } from 'react';
import { MarkdownEditor } from './MarkdownEditor';
import { EditorWindow, type EditorChoice } from './EditorWindow';

export function QuestionEditor({value,onChange,onFlush,onClose,saveState,path,choices,onChoose,onNew}:{
  value:string;onChange:(v:string)=>void;onFlush:()=>Promise<void>;onClose:()=>void;
  saveState:'saved'|'dirty'|'saving'|'error';path:string;choices:EditorChoice[];onChoose:(path:string)=>void;onNew:()=>void|Promise<void>;
}) {
  const [error,setError]=useState('');
  const save=async(next?:()=>void|Promise<void>)=>{try{await onFlush();setError('');await next?.();}catch(e){setError(`保存失败，编辑保留：${String(e)}`);}};
  const status=error||(saveState==='saved'?'已保存':saveState==='error'?'保存失败，编辑保留':saveState==='saving'?'保存中…':'等待保存…');
  return <EditorWindow title="完整问题" status={status} path={path} choices={choices} onChoose={p=>void save(()=>onChoose(p))} onNew={()=>void save(onNew)} onSave={()=>void save()} onClose={()=>void save(onClose)}>
    <MarkdownEditor label="完整问题Markdown" value={value} onChange={text=>{setError('');onChange(text);}} onSave={()=>void save()}/>
  </EditorWindow>;
}
