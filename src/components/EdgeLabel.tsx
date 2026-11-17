import { MarkdownView } from './MarkdownView';
export function EdgeLabel({label,x,y,zoom,onSelect,onEdit}: {label:string;x:number;y:number;zoom:number;onSelect:()=>void;onEdit:()=>void}) {
  return zoom<.6?<button className="edge-label-hint" style={{left:x,top:y}} aria-label={`连线说明：${label}`} title={label} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onSelect();}} onDoubleClick={e=>{e.stopPropagation();onEdit();}}><i/><i/><i/></button>:
    <div className="edge-label-rendered" role="button" tabIndex={0} aria-label={`连线说明：${label}`} style={{left:x,top:y,transform:`translate(-50%,-50%) scale(${zoom})`}} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onSelect();}} onDoubleClick={e=>{e.stopPropagation();onEdit();}} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();onEdit();}}}><MarkdownView value={label} inline/></div>;
}
