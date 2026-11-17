import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocRef } from '../api';
import { documentPayload } from '../documents/client';
import type { DocumentPayload } from '../documents/core';
import { useDocumentImages } from '../documents/useDocumentImages';
import { renderRichMarkdown } from '../documents/render';
import { typesetMath } from '../reader/reader';
import { MarkdownView } from './MarkdownView';
import { StickerImage } from './StickerImage';
import { imageDoc } from '../canvas/composition';

/** The first mounted resource has a readable, offline canvas preview. */
export function NodeAttachment({ projectId, boardId, doc, refresh = 0 }: {
  projectId: string; boardId: string; doc: DocRef; refresh?: number;
}) {
  if (imageDoc(doc)) return <div className="node-primary-image"><StickerImage projectId={projectId} boardId={boardId} path={doc.path}/></div>;
  return <DocumentOpening projectId={projectId} boardId={boardId} doc={doc} refresh={refresh}/>;
}
function DocumentOpening({projectId,boardId,doc,refresh}: {projectId:string;boardId:string;doc:DocRef;refresh:number}) {
  const [payload,setPayload]=useState<DocumentPayload>(),[error,setError]=useState('');
  useEffect(()=>{let active=true;setPayload(undefined);setError('');void documentPayload(projectId,boardId,doc.path).then(p=>active&&setPayload(p)).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[projectId,boardId,doc.path,doc.bytes,refresh]);
  const images=useDocumentImages(projectId,boardId,doc.path,payload?.attachment,payload?.scope),ref=useRef<HTMLDivElement>(null);
  const snippet=payload?.markdown.slice(0,1600)??'';
  const html=useMemo(()=>payload?.attachment?.kind==='markdown_bundle'?renderRichMarkdown(snippet,payload.attachment,images.urls).html:undefined,[snippet,payload?.attachment,images.urls]);
  useLayoutEffect(()=>{if(ref.current&&html){const job=typesetMath(ref.current,24);return()=>job.cancel();}},[html]);
  if(error)return <div className="node-resource-error" data-content-status="error">文档暂时无法预览</div>;
  if(!payload)return <div className="node-resource-loading" data-content-status="loading">正在读取文档…</div>;
  if(payload.attachment?.kind==='pdf')return <div className="node-document-opening" data-content-status="ready"><strong>PDF · {payload.attachment.pages} 页</strong><MarkdownView value={snippet}/></div>;
  const waiting=!!payload.attachment&&Object.values(payload.attachment.images).some(a=>!images.urls[a.path])&&!images.error;
  return <div className="node-document-opening" data-content-status={images.error?'error':waiting?'loading':'ready'}>
    {html!==undefined?<div ref={ref} className="markdown-body markdown-live" dangerouslySetInnerHTML={{__html:html}} onClick={e=>{if((e.target as HTMLElement).closest('a'))e.preventDefault();}}/>:<MarkdownView value={snippet}/>}
    {payload.markdown.length>snippet.length&&<span className="node-document-more" aria-label="文档开头预览，完整正文可在阅读器或编辑器中打开">…</span>}
  </div>;
}
