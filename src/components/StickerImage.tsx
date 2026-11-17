import { useEffect, useState } from 'react';
import { documentPayload } from '../documents/client';
import type { DocumentMetadata } from '../documents/core';
import { useDocumentImages } from '../documents/useDocumentImages';
export function StickerImage({projectId,boardId,path}:{projectId:string;boardId:string;path:string}) {
  const [metadata,setMetadata]=useState<DocumentMetadata|null>(null),[scope,setScope]=useState<string>(),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void documentPayload(projectId,boardId,path).then(p=>{if(alive){setMetadata(p.attachment);setScope(p.scope);}}).catch(e=>alive&&setError(String(e)));return()=>{alive=false;};},[projectId,boardId,path]);
  const images=useDocumentImages(projectId,boardId,path,metadata,scope),url=Object.values(images.urls)[0];
  return url?<img data-content-status="ready" className="sticker-image" src={url} alt="白板贴图" draggable={false}/>:<div data-content-status={error||images.error?"error":"loading"} className="sticker-loading">{error||images.error||'正在载入贴图…'}</div>;
}
