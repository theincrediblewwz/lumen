import { useEffect, useLayoutEffect, type RefObject } from 'react';

/** Keep native editing/selection; let CSS cap height before internal scrolling. */
export function useGrowingTextarea(ref:RefObject<HTMLTextAreaElement>,text:string,active:boolean){
  const measure=()=>{
    const input=ref.current;if(!input||!active||!input.getClientRects().length)return;
    const oldScroll=input.scrollTop;
    input.style.height='auto';
    const style=getComputedStyle(input);
    const border=(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.borderBottomWidth)||0);
    input.style.height=`${input.scrollHeight+border}px`;
    input.style.overflowY=input.scrollHeight>input.clientHeight+1?'auto':'hidden';
    input.scrollTop=oldScroll;
  };
  useLayoutEffect(measure,[text,active]);
  useEffect(()=>{
    const input=ref.current;if(!input||!active)return;
    let width=input.clientWidth;
    const resize=()=>measure();
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(()=>{if(input.clientWidth!==width){width=input.clientWidth;measure();}});
    observer?.observe(input);window.addEventListener('resize',resize);measure();
    return()=>{observer?.disconnect();window.removeEventListener('resize',resize);};
  },[active]);
}
