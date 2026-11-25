import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { BoardNode } from '../api';
import type { Box } from '../canvas/geometry';
import { moveFlowStep } from '../canvas/composition';
import { flowPanelWidth } from '../canvas/preview';
import { NodeCard } from './NodeCard';
import { MarkdownView } from './MarkdownView';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

type DragStart = { pointer: number; x: number; y: number; scroll: number; moved: boolean };
type Reorder = DragStart & {
  kind: 'reorder'; id: string; currentY: number; order: string[];
  boxes: Map<string, { y: number; h: number }>; index: number; offset: number;
};
type Drag = (DragStart & { kind: 'pan'; id?: string }) | Reorder;

export function FlowPanel({owner,nodes,projectId,boardId,selected,panelId,ownerBox,zoomSensitivity,onClose,onSelect,onAdd,onReorder,onRemove,docVersions,filtering,onEditTags}: {
  owner:BoardNode;nodes:BoardNode[];projectId:string;boardId:string;selected:string|null;panelId:string|null;ownerBox:Box;zoomSensitivity:number;
  onClose:()=>void;onSelect:(id:string)=>void;onAdd:(after?:string)=>void;onReorder:(ids:string[])=>void;onRemove:(id:string)=>void;docVersions:Record<string,number>;
  filtering: boolean;
  onEditTags: (node: BoardNode) => void;
}) {
  const [edit,setEdit]=useState(false),[collapsed,setCollapsed]=useState(false),[width,setWidth]=useState<number>(),[canvasWidth,setCanvasWidth]=useState(window.innerWidth),[menu,setMenu]=useState<ContextMenuState|null>(null),[,refresh]=useState(0);
  const panel=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),scroller=useRef<HTMLDivElement>(null),drag=useRef<Drag>(),frame=useRef(0);
  const resize=useRef<{pointer:number;start:number;width:number;target:HTMLElement}>();
  const handledClick = useRef(false);
  const maskId=`flow-cover-${useId().replace(/:/g,'')}`;
  const settling=useRef<Map<string,number>>();
  const [bounds,setBounds]=useState<Box>();
  const [cover,setCover]=useState<Box>();
  // Leave the scroll gutter reachable when the question panel is beside the flow.
  const spaceBeforePanel = bounds && cover && cover.y < bounds.y + bounds.h && cover.y + cover.h > bounds.y
    ? cover.x - bounds.x - 8 : 0;
  const available = spaceBeforePanel >= 280 ? Math.min(canvasWidth, spaceBeforePanel + 32) : canvasWidth;
  const updateBounds=()=>{const el=panel.current;if(!el)return;const host=el.closest('.board-canvas-live')!,r=el.getBoundingClientRect(),parent=host.getBoundingClientRect(),nodePanel=host.querySelector('.node-panel')?.getBoundingClientRect();
    const same=(a:Box|undefined,b:Box|undefined)=>a?.x===b?.x&&a?.y===b?.y&&a?.w===b?.w&&a?.h===b?.h;
    const next={x:r.x-parent.x,y:r.y-parent.y,w:r.width,h:r.height},occlusion=nodePanel?{x:nodePanel.x-parent.x,y:nodePanel.y-parent.y,w:nodePanel.width,h:nodePanel.height}:undefined;
    setBounds(old=>same(old,next)?old:next);setCover(old=>same(old,occlusion)?old:occlusion);setCanvasWidth(parent.width);
  };
  useLayoutEffect(()=>{updateBounds();const observer=new ResizeObserver(updateBounds),nodePanel=panel.current?.closest('.board-canvas-live')?.querySelector('.node-panel');if(panel.current){observer.observe(panel.current);observer.observe(panel.current.closest('.board-canvas-live')!);}if(nodePanel)observer.observe(nodePanel);
    const mutations=new MutationObserver(updateBounds);if(nodePanel)mutations.observe(nodePanel,{attributes:true,attributeFilter:['style','class']});window.addEventListener('resize',updateBounds);nodePanel?.addEventListener('animationend',updateBounds);
    return()=>{observer.disconnect();mutations.disconnect();window.removeEventListener('resize',updateBounds);nodePanel?.removeEventListener('animationend',updateBounds);};},[panelId]);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    let pinchWidth: number | undefined;
    const startPinch = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!drag.current && !resize.current) pinchWidth = el.getBoundingClientRect().width;
    };
    const changePinch = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const scale = (event as Event & { scale?: number }).scale;
      if (pinchWidth !== undefined && typeof scale === 'number' && scale > 0 && Number.isFinite(scale)) {
        setWidth(flowPanelWidth(pinchWidth * Math.pow(scale, zoomSensitivity), available));
      }
    };
    const endPinch = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      pinchWidth = undefined;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY || event.deltaX;
      if (!delta || drag.current || resize.current || pinchWidth !== undefined) return;
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1;
      const factor = Math.exp(-delta * unit * 0.0015 * zoomSensitivity);
      setWidth(previous => flowPanelWidth(flowPanelWidth(previous ?? rect.width, available) * factor, available));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', startPinch, { passive: false });
    el.addEventListener('gesturechange', changePinch, { passive: false });
    el.addEventListener('gestureend', endPinch, { passive: false });
    const clearPinch = () => { pinchWidth = undefined; };
    window.addEventListener('blur', clearPinch);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', startPinch);
      el.removeEventListener('gesturechange', changePinch);
      el.removeEventListener('gestureend', endPinch);
      window.removeEventListener('blur', clearPinch);
    };
  }, [available, zoomSensitivity]);
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
  useEffect(() => {
    const cancel = () => {
      const active = drag.current;
      drag.current = undefined;
      if (active && scroller.current?.hasPointerCapture(active.pointer)) scroller.current.releasePointerCapture(active.pointer);
      if (active?.kind === 'reorder' && active.moved) refresh(n => n + 1);
      const resizing = resize.current;
      if (resizing) {
        resize.current = undefined;
        setWidth(resizing.width);
        if (resizing.target.hasPointerCapture(resizing.pointer)) resizing.target.releasePointerCapture(resizing.pointer);
      }
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    window.addEventListener('blur', cancel);
    return () => { cancelAnimationFrame(frame.current); window.removeEventListener('blur', cancel); };
  }, []);

  const updateOrder = (d: Reorder, scrollTop: number) => {
    const offset = d.currentY - d.y + scrollTop - d.scroll;
    if (offset === d.offset) return false;
    d.offset = offset;
    const dragged = d.boxes.get(d.id)!;
    const center = dragged.y + dragged.h / 2 + offset;
    d.index = d.order.filter(id => {
      const box = d.boxes.get(id)!;
      return id !== d.id && box.y + box.h / 2 < center;
    }).length;
    return true;
  };
  const tick = () => {
    const d = drag.current, scrollerEl = scroller.current;
    if (d?.kind !== 'reorder' || !scrollerEl) { frame.current = 0; return; }
    const { top, bottom } = scrollerEl.getBoundingClientRect();
    const direction = d.currentY < top + 45 ? -1 : d.currentY > bottom - 45 ? 1 : 0;
    const depth = direction === -1 ? top + 45 - d.currentY : d.currentY - bottom + 45;
    const before = scrollerEl.scrollTop;
    if (direction) scrollerEl.scrollTop += direction * Math.min(14, depth / 3);
    if (updateOrder(d, scrollerEl.scrollTop)) refresh(n => n + 1);
    frame.current = scrollerEl.scrollTop !== before ? requestAnimationFrame(tick) : 0;
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || event.ctrlKey || drag.current || resize.current) return;
    const el = event.currentTarget;
    const { left, top } = el.getBoundingClientRect();
    if (event.clientX >= left + el.clientLeft + el.clientWidth || event.clientY >= top + el.clientTop + el.clientHeight) return;
    const target = event.target as Element;
    if (target.closest('button, input, textarea, select, a, [contenteditable]')) return;
    const id = target.closest<HTMLElement>('.node-card')?.dataset.nodeId;
    // The browser can scroll a clipped card into view on focus before delivering a click.
    event.preventDefault();
    const origin = { pointer: event.pointerId, x: event.clientX, y: event.clientY, scroll: el.scrollTop, moved: false };
    if (id && selected === id && edit) {
      const boxes = new Map<string, { y: number; h: number }>();
      list.current?.querySelectorAll<HTMLElement>('[data-flow-step]').forEach(step => {
        const { y, height } = step.getBoundingClientRect();
        boxes.set(step.dataset.flowStep!, { y, h: height });
      });
      drag.current = { ...origin, kind: 'reorder', id, currentY: origin.y, order: nodes.map(node => node.id), boxes,
        index: nodes.findIndex(node => node.id === id), offset: 0 };
    } else {
      drag.current = { ...origin, kind: 'pan', id };
    }
    el.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(event.clientX - d.x, dy) <= 4) return;
    d.moved = true;
    if (d.kind === 'pan') event.currentTarget.scrollTop = d.scroll - dy;
    else d.currentY = event.clientY;
    return d;
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const committed = event.type === 'pointerup';
    if (committed) move(event);
    drag.current = undefined;
    handledClick.current = true;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (committed && !d.moved && d.id) onSelect(d.id);
    if (d.kind !== 'reorder' || !d.moved) return;
    if (committed) {
      const steps = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-flow-step]') ?? []);
      updateOrder(d, event.currentTarget.scrollTop);
      if (d.order[d.index] !== d.id) {
        settling.current = new Map(steps.map(step => [step.dataset.flowStep!, step.getBoundingClientRect().top]));
        steps.forEach(step => { step.style.transition = 'none'; });
        onReorder(moveFlowStep(d.order, d.id, d.index));
      }
    }
    refresh(n => n + 1);
  };
  const corners=(b:Box)=>[{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x,y:b.y+b.h},{x:b.x+b.w,y:b.y+b.h}];
  const color=owner.color||'var(--accent)';
  return <>
    {bounds&&<svg className="flow-light-paths" aria-hidden="true"><defs><filter id="flow-soft-glow"><feGaussianBlur stdDeviation="4"/></filter><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"><rect width="100%" height="100%" fill="white"/>{cover&&<rect data-flow-occlusion x={cover.x-1} y={cover.y-1} width={cover.w+2} height={cover.h+2} rx="16" fill="black"/>}</mask></defs><g mask={`url(#${maskId})`}>{corners(ownerBox).map((p,i)=>{const q=corners(bounds)[i],dx=(q.x-p.x)*.45,path=`M${p.x} ${p.y} C${p.x+dx} ${p.y} ${q.x-dx} ${q.y} ${q.x} ${q.y}`;return <g key={i} style={{color}}><path d={path} className="flow-light-outer"/><path d={path} className="flow-light-inner"/></g>;})}</g></svg>}
    <section data-flow-owner={owner.id} ref={panel} className={`flow-panel glass-surface${edit?' is-editing':''}${collapsed?' is-preview-collapsed':''}`} aria-label={`子白板：${owner.title||'流程'}`}
      style={{ ['--flow-color' as string]: color, width: width === undefined ? undefined : flowPanelWidth(width, available), maxWidth: flowPanelWidth(Infinity, available) }}
      onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}}>
      <header><div><span>子白板 · 线性流程</span><strong><MarkdownView value={owner.title||'流程'} inline/></strong></div><button className="btn flow-preview-toggle" aria-label={collapsed?'展开全部步骤预览':'收起全部步骤预览'} title={collapsed?'显示各步骤的分页素材预览':'只显示步骤标题和编号，不影响母白板'} aria-pressed={collapsed} onClick={()=>setCollapsed(v=>!v)}>{collapsed?'展开预览':'收起预览'}</button><button className="btn" title="编辑时可拖动步骤换位，右键可在下方插入" aria-pressed={edit} onClick={()=>setEdit(v=>!v)}>{edit?'完成编辑':'编辑'}</button><button className="flow-close" aria-label="收起子白板" onClick={onClose}>×</button></header>
      <div className="flow-resize-e" role="separator" aria-orientation="vertical" aria-label="调整子白板宽度" tabIndex={0} aria-valuenow={Math.round(bounds?.w??520)}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || drag.current || resize.current) return;
          event.preventDefault();
          resize.current = { pointer: event.pointerId, start: event.clientX, width: panel.current!.getBoundingClientRect().width, target: event.currentTarget };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const d = resize.current;
          if (d?.pointer === event.pointerId) setWidth(flowPanelWidth(d.width + event.clientX - d.start, available));
        }} onPointerUp={event => { if (resize.current?.pointer === event.pointerId) resize.current = undefined; }}
        onLostPointerCapture={event => {
          const d = resize.current;
          if (d?.pointer === event.pointerId) { resize.current = undefined; setWidth(d.width); }
        }} onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          setWidth(flowPanelWidth((bounds?.w ?? 520) + (event.key === 'ArrowRight' ? 32 : -32), available));
        }}/>
      <div ref={scroller} className="flow-scroll" tabIndex={0} aria-label="流程步骤"
        onPointerDownCapture={() => { handledClick.current = false; }} onPointerDown={start}
        onPointerMove={event => {
          if (move(event)?.kind === 'reorder' && !frame.current) frame.current = requestAnimationFrame(tick);
        }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
        onClickCapture={event => { if (handledClick.current && event.detail) event.stopPropagation(); }}
        onDoubleClickCapture={event => { if (handledClick.current && event.detail) event.stopPropagation(); }}>
        {!nodes.length&&<p className="flow-empty">{filtering?'当前没有匹配标签的步骤':edit?'添加第一个步骤，技术细节将在这里依次展开。':'这个流程还没有步骤，点击右上角编辑。'}</p>}
        <div ref={list} className="flow-list">{nodes.map((node,index)=>{
          const active = drag.current;
          const d=active?.kind==='reorder'&&active.moved?active:undefined,from=d?.order.indexOf(d.id)??-1,at=d?.order.indexOf(node.id)??-1,amount=d?(d.boxes.get(d.id)?.h??0)+44:0;
          const offset=d?.id===node.id?d.offset:d&&at>from&&at<=d.index?-amount:d&&at<from&&at>=d.index?amount:0;
          return <div key={node.id} data-flow-step={node.id} className={`flow-step${d?.id===node.id?' is-dragging':''}`} style={{transform:`translateY(${offset}px)`}}>
            <span className="flow-step-number">{filtering ? (owner.flow?.nodeIds.indexOf(node.id) ?? index) + 1 : index + 1}</span>
            <NodeCard node={{...node,x:0,y:0}} projectId={projectId} boardId={boardId} docVersions={docVersions} previewCollapsed={collapsed} hideHandles selected={selected===node.id} editing={false} showAnchors={false} onPointerDown={()=>{}} onAnchorPointerDown={()=>{}} onResizeStart={()=>{}} onOpen={onSelect} onStartEdit={onSelect} onContextMenu={e=>{
              e.preventDefault();
              e.stopPropagation();
              setMenu({x:e.clientX,y:e.clientY,items:[
                {type:'item',label:'编辑标签…',onClick:()=>onEditTags(node)},
                ...(edit ? [
                  {type:'item' as const,label:'在此步骤下方插入',onClick:()=>onAdd(node.id)},
                  {type:'item' as const,label:'移除此步骤',danger:true,onClick:()=>onRemove(node.id)},
                ] : [{type:'item' as const,label:'编辑流程',onClick:()=>setEdit(true)}]),
              ]});
            }} onCommit={()=>{}} onEditCancel={()=>{}} onExitEdit={()=>{}} onMeasure={()=>{}} onHoverChange={()=>{}}/>
            {index<nodes.length-1 && (!filtering || owner.flow?.nodeIds[owner.flow.nodeIds.indexOf(node.id) + 1] === nodes[index+1].id)
              && <span className="flow-arrow" aria-hidden="true">↓</span>}
          </div>;
        })}</div>
      </div>
      {edit&&<button className="flow-add-fab glass-surface" aria-label="＋ 添加步骤到末尾" title="在流程末尾添加步骤" onClick={()=>onAdd()}><span aria-hidden="true">＋</span> 添加步骤</button>}
      {menu&&<ContextMenu state={menu} onClose={()=>setMenu(null)}/>}
    </section>
  </>;
}
