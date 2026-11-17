import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardNode } from '../api';
import type { Box } from '../canvas/geometry';
import { moveFlowStep } from '../canvas/composition';
import { NodeCard } from './NodeCard';
import { MarkdownView } from './MarkdownView';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

type Drag = { id:string; pointer:number; start:number; current:number; scroll:number; order:string[]; boxes:Map<string,{y:number;h:number}>; index:number; offset:number; moved:boolean };
export function FlowPanel({owner,nodes,projectId,boardId,selected,ownerBox,onClose,onSelect,onAdd,onReorder,onRemove,docVersions}: {
  owner:BoardNode;nodes:BoardNode[];projectId:string;boardId:string;selected:string|null;ownerBox:Box;
  onClose:()=>void;onSelect:(id:string)=>void;onAdd:(after?:string)=>void;onReorder:(ids:string[])=>void;onRemove:(id:string)=>void;docVersions:Record<string,number>;
}) {
  const [edit,setEdit]=useState(false),[menu,setMenu]=useState<ContextMenuState|null>(null),[,refresh]=useState(0);
  const panel=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),scroller=useRef<HTMLDivElement>(null),drag=useRef<Drag>(),frame=useRef(0);
  const settling=useRef<Map<string,number>>();
  const [bounds,setBounds]=useState<Box>();
  const updateBounds=()=>{const el=panel.current;if(!el)return;const r=el.getBoundingClientRect(),parent=el.closest('.board-canvas-live')!.getBoundingClientRect();setBounds(old=>old&&old.x===r.x-parent.x&&old.y===r.y-parent.y&&old.w===r.width&&old.h===r.height?old:{x:r.x-parent.x,y:r.y-parent.y,w:r.width,h:r.height});};
  useLayoutEffect(()=>{updateBounds();const observer=new ResizeObserver(updateBounds);if(panel.current)observer.observe(panel.current);window.addEventListener('resize',updateBounds);return()=>{observer.disconnect();window.removeEventListener('resize',updateBounds);};},[]);
  useLayoutEffect(()=>{
    const before=settling.current;if(!before)return;settling.current=undefined;
    list.current?.querySelectorAll<HTMLElement>('[data-flow-step]').forEach(el=>{
      const delta=(before.get(el.dataset.flowStep!)??el.getBoundingClientRect().top)-el.getBoundingClientRect().top;
      const restore=()=>{el.style.transition='';};
      if(Math.abs(delta)<.5||!el.animate){restore();return;}
      // Animate from the last visible position to the new layout, rather than
      // applying the preview transform a second time after DOM reordering.
      const animation=el.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(.2,.7,.2,1)'});
      void animation.finished.then(restore,restore);
    });
  },[nodes]);
  useEffect(()=>{const cancel=()=>{drag.current=undefined;cancelAnimationFrame(frame.current);refresh(n=>n+1);};window.addEventListener('blur',cancel);return()=>{cancelAnimationFrame(frame.current);window.removeEventListener('blur',cancel);};},[]);
  const tick=()=>{
    const d=drag.current,s=scroller.current;if(!d||!s)return;
    if(Math.abs(d.current-d.start)>4)d.moved=true;
    const r=s.getBoundingClientRect(),speed=!d.moved?0:d.current<r.top+45?-Math.min(14,(r.top+45-d.current)/3):d.current>r.bottom-45?Math.min(14,(d.current-r.bottom+45)/3):0;
    if(speed)s.scrollTop+=speed;
    d.offset=d.current-d.start+s.scrollTop-d.scroll;
    const center=d.boxes.get(d.id)!.y+d.boxes.get(d.id)!.h/2+d.offset;
    d.index=d.order.filter(id=>id!==d.id&&d.boxes.get(id)!.y+d.boxes.get(id)!.h/2<center).length;
    refresh(n=>n+1);frame.current=requestAnimationFrame(tick);
  };
  const start=(event:React.PointerEvent,id:string)=>{
    if(event.button!==0||(event.target as HTMLElement).closest('button,input,textarea,a'))return;
    // Keep the clicked pixels in place: focusing a partially visible card scrolls it
    // before click dispatch. A tap must also never start drag autoscrolling.
    event.preventDefault();event.stopPropagation();
    if(!edit){onSelect(id);return;}
    const boxes=new Map<string,{y:number;h:number}>();list.current?.querySelectorAll<HTMLElement>('[data-flow-step]').forEach(el=>{const b=el.getBoundingClientRect();boxes.set(el.dataset.flowStep!,{y:b.y,h:b.height});});
    drag.current={id,pointer:event.pointerId,start:event.clientY,current:event.clientY,scroll:scroller.current?.scrollTop??0,order:nodes.map(n=>n.id),boxes,index:nodes.findIndex(n=>n.id===id),offset:0,moved:false};panel.current?.setPointerCapture(event.pointerId);frame.current=requestAnimationFrame(tick);
  };
  const stop=(event:React.PointerEvent)=>{
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;event.stopPropagation();
    if(event.type==='pointerup'){
      d.current=event.clientY;d.offset=d.current-d.start+(scroller.current?.scrollTop??0)-d.scroll;
      const center=d.boxes.get(d.id)!.y+d.boxes.get(d.id)!.h/2+d.offset;
      d.index=d.order.filter(id=>id!==d.id&&d.boxes.get(id)!.y+d.boxes.get(id)!.h/2<center).length;
      if(Math.abs(d.current-d.start)>4)d.moved=true;
    }
    drag.current=undefined;cancelAnimationFrame(frame.current);
    if(panel.current?.hasPointerCapture(event.pointerId))panel.current.releasePointerCapture(event.pointerId);
    if(event.type==='pointerup'){
      if(d.moved){
        settling.current=new Map(Array.from(list.current?.querySelectorAll<HTMLElement>('[data-flow-step]')??[]).map(el=>[el.dataset.flowStep!,el.getBoundingClientRect().top]));
        list.current?.querySelectorAll<HTMLElement>('[data-flow-step]').forEach(el=>{el.style.transition='none';});
        onReorder(moveFlowStep(d.order,d.id,d.index));
      }else onSelect(d.id);
    }refresh(n=>n+1);
  };
  const select=(id:string)=>onSelect(id);
  const corners=(b:Box)=>[{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x,y:b.y+b.h},{x:b.x+b.w,y:b.y+b.h}];
  const color=owner.color||'var(--accent)';
  return <>
    {bounds&&<svg className="flow-light-paths" aria-hidden="true"><defs><filter id="flow-soft-glow"><feGaussianBlur stdDeviation="4"/></filter></defs>{corners(ownerBox).map((p,i)=>{const q=corners(bounds)[i],dx=(q.x-p.x)*.45,path=`M${p.x} ${p.y} C${p.x+dx} ${p.y} ${q.x-dx} ${q.y} ${q.x} ${q.y}`;return <g key={i} style={{color}}><path d={path} className="flow-light-outer"/><path d={path} className="flow-light-inner"/></g>;})}</svg>}
    <section data-flow-owner={owner.id} ref={panel} className={`flow-panel glass-surface${edit?' is-editing':''}`} aria-label={`子白板：${owner.title||'流程'}`} style={{['--flow-color' as string]:color}} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}}
      onPointerMove={e=>{if(drag.current)drag.current.current=e.clientY;}} onPointerUp={stop} onPointerCancel={stop}>
      <header><div><span>子白板 · 线性流程</span><strong><MarkdownView value={owner.title||'流程'} inline/></strong></div><button className="btn" title="编辑时可拖动步骤换位，右键可在下方插入" aria-pressed={edit} onClick={()=>setEdit(v=>!v)}>{edit?'完成编辑':'编辑'}</button><button className="flow-close" aria-label="收起子白板" onClick={onClose}>×</button></header>
      <div ref={scroller} className="flow-scroll" tabIndex={0} aria-label="流程步骤">
        {!nodes.length&&<p className="flow-empty">{edit?'添加第一个步骤，技术细节将在这里依次展开。':'这个流程还没有步骤，点击右上角编辑。'}</p>}
        <div ref={list} className="flow-list">{nodes.map((node,index)=>{
          const d=drag.current,from=d?.order.indexOf(d.id)??-1,at=d?.order.indexOf(node.id)??-1,amount=d?(d.boxes.get(d.id)?.h??0)+44:0;
          const offset=d?.id===node.id?d.offset:d&&at>from&&at<=d.index?-amount:d&&at<from&&at>=d.index?amount:0;
          return <div key={node.id} data-flow-step={node.id} className={`flow-step${d?.id===node.id?' is-dragging':''}`} style={{transform:`translateY(${offset}px)`}}>
            <span className="flow-step-number">{index+1}</span>
            <NodeCard node={{...node,x:0,y:0}} projectId={projectId} boardId={boardId} docVersions={docVersions} hideHandles selected={selected===node.id} editing={false} showAnchors={false} onPointerDown={e=>start(e,node.id)} onAnchorPointerDown={()=>{}} onResizeStart={()=>{}} onOpen={()=>select(node.id)} onStartEdit={()=>select(node.id)} onContextMenu={e=>{e.preventDefault();e.stopPropagation();setMenu({x:e.clientX,y:e.clientY,items:edit?[{type:'item',label:'在此步骤下方插入',onClick:()=>onAdd(node.id)},{type:'item',label:'移除此步骤',danger:true,onClick:()=>onRemove(node.id)}]:[{type:'item',label:'编辑流程',onClick:()=>setEdit(true)}]});}} onCommit={()=>{}} onEditCancel={()=>{}} onExitEdit={()=>{}} onMeasure={()=>{}} onHoverChange={()=>{}}/>
            {index<nodes.length-1&&<span className="flow-arrow" aria-hidden="true">↓</span>}
          </div>;
        })}</div>
      </div>
      {edit&&<button className="flow-add-fab glass-surface" aria-label="＋ 添加步骤到末尾" title="在流程末尾添加步骤" onClick={()=>onAdd()}><span aria-hidden="true">＋</span> 添加步骤</button>}
      {menu&&<ContextMenu state={menu} onClose={()=>setMenu(null)}/>}
    </section>
  </>;
}
