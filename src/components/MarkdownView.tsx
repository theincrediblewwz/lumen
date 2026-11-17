import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { renderMarkdown } from '../reader/engine';
import { typesetMath } from '../reader/reader';

/** Shared, offline Markdown for titles, question documents and live previews. */
export const MarkdownView = memo(function MarkdownView({value, className='', inline=false}: {
  value:string; className?:string; inline?:boolean;
}) {
  const ref=useRef<HTMLDivElement>(null);
  const html=useMemo(()=>DOMPurify.sanitize(renderMarkdown(value,undefined,{guessMath:true}).html,
    {FORBID_TAGS:['img','iframe','style','script','input','form'],FORBID_ATTR:['style']}),[value]);
  useLayoutEffect(()=>{
    if(ref.current && ref.current.querySelectorAll('[data-tex]').length>24){const job=typesetMath(ref.current,16);return()=>job.cancel();}
    ref.current?.querySelectorAll<HTMLElement>('[data-tex]').forEach(el=>{
      try { katex.render(el.dataset.tex??'',el,{displayMode:el.classList.contains('math-block'),throwOnError:false,trust:false,strict:false}); el.setAttribute('data-done','1'); }
      catch { el.textContent=el.dataset.tex??''; el.setAttribute('data-done','1'); }
    });
  },[html]);
  return <div ref={ref} className={`markdown-body markdown-live${inline?' is-inline':''} ${className}`} dangerouslySetInnerHTML={{__html:html}} onClick={e=>{
    if((e.target as HTMLElement).closest('a'))e.preventDefault();
  }}/>;
});
