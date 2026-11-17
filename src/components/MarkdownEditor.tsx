import { useDeferredValue, useRef, useState } from 'react';
import { MarkdownView } from './MarkdownView';

export function MarkdownEditor({value,onChange,label='Markdown正文',compact=false,onSave}: {
  value:string; onChange:(v:string)=>void; label?:string; compact?:boolean; onSave?:()=>void;
}) {
  const area=useRef<HTMLTextAreaElement>(null);
  const preview=useDeferredValue(value);
  const [mode,setMode]=useState<'split'|'write'|'read'>('split');
  const insert=(before:string,after='',fallback='文字')=>{
    const el=area.current;if(!el)return;
    const start=el.selectionStart,end=el.selectionEnd,selection=value.slice(start,end)||fallback;
    onChange(value.slice(0,start)+before+selection+after+value.slice(end));
    requestAnimationFrame(()=>{el.focus();el.setSelectionRange(start+before.length,start+before.length+selection.length);});
  };
  return <div className={`markdown-editor${compact?' is-compact':''}`} onPointerDown={e=>e.stopPropagation()}>
    <div className="md-editor-toolbar" role="toolbar" aria-label={`${label}格式`}>
      {[
        ['粗体','B','**','**'],['斜体','I','*','*'],['标题','H','## ',''],['列表','•','- ',''],
        ['引用','❯','> ',''],['代码','<>','`','`'],['代码块','```','\n```\n','\n```\n'],
        ['链接','↗','[','](https://example.com)'],['公式','∑','$','$'],['块公式','∫','\n$$\n','\n$$\n'],
      ].map(([title,text,before,after])=><button key={title} type="button" title={title} aria-label={title} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(before,after,title==='公式'?'\\nu':'文字')}>{text}</button>)}
      <span className="md-editor-modes">{([['write','编辑'],['split','分栏'],['read','预览']] as const).map(([id,text])=><button type="button" key={id} aria-pressed={mode===id} onClick={()=>setMode(id)}>{text}</button>)}</span>
    </div>
    <div className={`md-editor-body mode-${mode}`}>
      {mode!=='read'&&<textarea ref={area} aria-label={label} value={value} spellCheck={false} placeholder="支持 Markdown、表格、代码及 $\\nu$ 等公式…" onChange={e=>onChange(e.target.value)} onKeyDown={e=>{
        if((e.metaKey||e.ctrlKey)&&['b','i','s'].includes(e.key.toLowerCase())){
          e.preventDefault();e.stopPropagation();const key=e.key.toLowerCase();
          if(key==='s')onSave?.();else insert(key==='b'?'**':'*',key==='b'?'**':'*');
        }
        if(e.key==='Tab'){e.preventDefault();const el=e.currentTarget,start=el.selectionStart,end=el.selectionEnd;onChange(value.slice(0,start)+'  '+value.slice(end));requestAnimationFrame(()=>el.setSelectionRange(start+2,start+2));}
      }}/>}
      {mode!=='write'&&<div className="md-editor-preview" aria-label={`${label}实时预览`}><MarkdownView value={preview||'开始写作，预览会显示在这里。'}/></div>}
    </div>
  </div>;
}
