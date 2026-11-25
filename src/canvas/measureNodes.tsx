import { createRoot } from 'react-dom/client';
import type { BoardNode } from '../api';
import { imageOnly, contentDocs } from './composition';
import { NodeCard } from '../components/NodeCard';
import type { PreviewMemory } from '../components/NodePreview';
import type { StagedDocumentPreview } from '../components/NodeAttachment';
import { boardAppearance, FONT_FAMILIES, type BoardAppearance } from './presentation';

type MeasureOptions = { appearance?: BoardAppearance; documents: Record<string, StagedDocumentPreview>; scope: string };

/** Use the actual card renderer, including offline images and KaTeX, in bounded batches. */
export async function measureNodes(host:HTMLElement,nodes:BoardNode[],projectId:string,boardId:string,signal:AbortSignal,progress:(done:number)=>void,options?:MeasureOptions) {
  const holder=document.createElement('div');holder.className='node-measure-layer';holder.setAttribute('aria-hidden','true');holder.inert=true;
  const previewMemory: PreviewMemory | undefined = options ? new Map() : undefined;
  if(options){
    const appearance = boardAppearance(options.appearance);
    holder.style.setProperty('--board-font-family', FONT_FAMILIES[appearance.fontFamily]);
    holder.style.setProperty('--board-font-size', `${appearance.fontSize}px`);
    holder.style.setProperty('--board-preview-font-family', FONT_FAMILIES[appearance.previewFontFamily]);
    holder.style.setProperty('--board-preview-font-size', `${appearance.previewFontSize}px`);
  }
  host.append(holder);
  const root=createRoot(holder),result=new Map<string,{w:number;h:number}>();
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const check=()=>{if(signal.aborted)throw Error('已停止整理，原布局保留');};
  try {
    for(let index=0;index<nodes.length;index+=64){
      check();const batch=nodes.slice(index,index+64).map(n=>{
        if(imageOnly(n)){const aspect=n.imageAspect||n.w/(n.h||n.w),longest=Math.min(600,Math.max(160,Math.max(n.w,n.h||n.w)));return {...n,w:aspect>=1?longest:longest*aspect,h:aspect>=1?longest/aspect:longest};}
        const length=(n.title+(n.summary??'')).length,w=contentDocs(n).length?420:length>600?480:length>120?380:260;
        return {...n,w,h:undefined};
      });
      root.render(<>{batch.map(node=><NodeCard key={node.id} node={node} projectId={projectId} boardId={boardId} measuring hideHandles selected={false} editing={false} showAnchors={false} onResizeStart={()=>{}} onPointerDown={()=>{}} onAnchorPointerDown={()=>{}} onOpen={()=>{}} onStartEdit={()=>{}} onContextMenu={()=>{}} onCommit={()=>{}} onEditCancel={()=>{}} onExitEdit={()=>{}} onMeasure={(id,w,h)=>result.set(id,{w:Math.ceil(w),h:Math.ceil(h)})} onHoverChange={()=>{}} previewMemory={previewMemory} stagedDocuments={options?.documents} expectedScope={options?.scope}/>)}</>);
      await frame();await frame();const started=performance.now();
      while(holder.querySelector('[data-content-status="loading"]')||holder.querySelector('.math[data-tex]:not([data-done])')||Array.from(holder.querySelectorAll('img')).some(img=>!img.complete)){
        check();if(performance.now()-started>20000)throw Error('部分节点资源尚未载入，原布局保留，请稍后重试');await frame();
      }
      await document.fonts.ready;await frame();await frame();check();
      if(holder.querySelector('[data-content-status="error"]'))throw Error('部分资源无法读取，原布局保留，请恢复资源后重试');
      if(batch.some(n=>!result.has(n.id)))throw Error('节点测量未完成，原布局保留');progress(Math.min(nodes.length,index+batch.length));
    }
    return result;
  } finally {root.unmount();holder.remove();}
}
