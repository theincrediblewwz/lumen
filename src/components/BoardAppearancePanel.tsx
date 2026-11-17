import { boardAppearance, type BoardAppearance } from '../canvas/presentation';
export function BoardAppearancePanel({value,onChange,onClose,name}:{value?:BoardAppearance;onChange:(v:BoardAppearance)=>void;onClose:()=>void;name:string}) {
  const v=boardAppearance(value);
  return <section className="board-appearance glass-surface" role="dialog" aria-label="白板设置" onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <header><strong>白板设置</strong><button className="btn" onClick={onClose} aria-label="关闭白板设置">×</button></header>
    <p>{name}</p><label>字体<select aria-label="白板字体" value={v.fontFamily} onChange={e=>onChange({...v,fontFamily:e.target.value as BoardAppearance['fontFamily']})}>
      <option value="system">系统字体</option><option value="sans">黑体</option><option value="serif">宋体</option><option value="mono">等宽字体</option>
    </select></label><label>字号 <output>{v.fontSize}px</output><input aria-label="白板字号" type="range" min="12" max="32" value={v.fontSize} onChange={e=>onChange({...v,fontSize:Number(e.target.value)})}/></label>
    <p>只应用于这块白板，自动保存。</p>
  </section>;
}
