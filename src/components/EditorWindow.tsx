import type { ReactNode } from 'react';

export type EditorChoice = {path:string;title:string};
export function EditorWindow({title,status,children,path,choices,onChoose,onNew,onSave,onClose}: {
  title:string;status:string;children:ReactNode;path:string;choices:EditorChoice[];
  onChoose:(path:string)=>void;onNew:()=>void;onSave:()=>void;onClose:()=>void;
}) {
  return <div className="markdown-window-backdrop" onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>e.stopPropagation()} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="document-editor-modal" role="dialog" aria-modal="true" aria-label={`Markdown编辑器：${title}`} onClick={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();onClose();}}}>
      <header className="editor-window-head">
        <span className="editor-window-kind">Markdown</span>
        <select className="editor-document-choice" aria-label="正在编辑的文档" title={title} value={path} onChange={e=>onChoose(e.target.value)}>{choices.map(d=><option key={d.path} value={d.path}>{d.title}</option>)}</select>
        <button className="btn editor-document-new" onClick={onNew}>新建 Markdown</button>
        <span className="editor-window-status" role="status">{status}</span>
        <button className="btn editor-save" onClick={onSave}>立即保存</button>
        <button className="editor-window-close" aria-label="保存并关闭" title="保存并关闭 · Esc" onClick={onClose}>×</button>
      </header>
      {children}
      <footer>自动保存<span>Cmd/Ctrl+S 立即保存 · Esc 或点击窗口外保存并关闭</span></footer>
    </section>
  </div>;
}
