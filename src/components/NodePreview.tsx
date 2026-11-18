import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DocRef } from '../api';
import { imageDoc } from '../canvas/composition';
import { stepPreview } from '../canvas/preview';
import { NodeAttachment, DocumentPages } from './NodeAttachment';

export type PreviewPresentation = { resourceKey: string; image: boolean; navigated: boolean; title: string; dimensions?: { width: number; height: number } };
const positions = new Map<string, { signature: string; position: { resource: number; page: number }; counts: Record<string, number>; navigated: boolean }>();
export function NodePreview({ summary, docs, projectId, boardId, docVersions, onPresentation, viewKey }: {
  summary?: string | null; docs: DocRef[]; projectId: string; boardId: string; docVersions: Record<string, number>;
  onPresentation: (value: PreviewPresentation) => void; viewKey: string;
}) {
  const resources = useMemo(() => [...(summary ? [{ key: 'question', title: '完整问题', summary }] : []), ...docs.map(doc => ({ key: doc.path, title: doc.title, doc }))], [summary, docs]);
  const signature = resources.map(r => r.key).join('\n'), cached = positions.get(viewKey), saved = cached?.signature === signature ? cached : undefined;
  const [position, setPosition] = useState(saved?.position ?? { resource: 0, page: 0 }), [navigated, setNavigated] = useState(saved?.navigated ?? false);
  const counts = useRef<Record<string, number>>({ ...saved?.counts }); const [pages, setPages] = useState(saved?.counts[resources[saved.position.resource]?.key] ?? 1);
  const resource = resources[Math.min(position.resource, resources.length - 1)];
  const [dimensions, setDimensions] = useState<{ key: string; width: number; height: number }>();
  const key = resource?.key ?? '', image = !!resource && 'doc' in resource && imageDoc(resource.doc);
  const previousSignature = useRef(signature);
  useEffect(() => {
    if (previousSignature.current === signature) return;
    const oldKeys=previousSignature.current.split('\n'),current=oldKeys[position.resource],oldPrimary=oldKeys.find(k=>k!=='question'),primary=resources.find(r=>r.key!=='question')?.key;
    const promoted=primary&&primary!==oldPrimary&&oldKeys.includes(primary)?primary:undefined;
    const target=promoted??(key==='question'&&!oldKeys.includes('question')?'question':current);
    const resource=Math.max(0,resources.findIndex(r=>r.key===target)),nextKey=resources[resource]?.key;
    previousSignature.current=signature;setPosition({resource,page:nextKey===current?position.page:0});setPages(counts.current[nextKey]??1);setNavigated(!!promoted||navigated);
  }, [signature]);
  useEffect(() => {
    positions.delete(viewKey); positions.set(viewKey, { signature, position, counts: { ...counts.current }, navigated });
    while (positions.size > 512) positions.delete(positions.keys().next().value!);
  }, [viewKey, signature, position, pages, navigated]);
  const onPages = useCallback((total: number) => { counts.current[key] = total; setPages(old => old === total ? old : total);setPosition(old=>old.page<total?old:{...old,page:total-1}); }, [key]);
  const onImageSize = useCallback((size: { width: number; height: number }) => setDimensions(old => old?.key === key && old.width === size.width && old.height === size.height ? old : { key, ...size }), [key]);
  useLayoutEffect(() => onPresentation({ resourceKey:key, image, navigated, title: resource?.title ?? '', dimensions: dimensions?.key === key ? dimensions : undefined }), [image, navigated, resource?.title, key, dimensions, onPresentation]);
  const turn = (direction = 1) => {
    const next = stepPreview(position, resources.map(r => counts.current[r.key] ?? 1), direction);
    setNavigated(true); setPosition(next); setPages(counts.current[resources[next.resource]?.key] ?? 1);
  };
  if (!resource) return null;
  const page = Math.min(position.page, pages - 1), hasMore = resources.length > 1 || pages > 1;
  return <div className={`node-preview${image ? ' is-image' : ''}`} data-preview-resource={resource.key} data-preview-index={position.resource} data-preview-page={page} data-preview-pages={pages}>
    {'doc' in resource ? <NodeAttachment key={resource.key} projectId={projectId} boardId={boardId} doc={resource.doc!} refresh={docVersions[resource.key] ?? 0} page={page} onPages={onPages} onImageSize={onImageSize}/>
      : <DocumentPages key={resource.key} markdown={resource.summary ?? ''} page={page} onPages={onPages} question/>}
    {hasMore && <button className="node-preview-next glass-surface" aria-label="下一页" title={`${resource.title} · 第${page + 1}/${pages}页 · 素材${position.resource + 1}/${resources.length}\n下一页；Shift+点击或左方向键返回上一页`} onPointerDown={e => {e.preventDefault();e.stopPropagation();}} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); turn(e.shiftKey ? -1 : 1); }} onKeyDown={e => {
      if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); turn(['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1); }
    }}><ChevronRight size={17} aria-hidden="true"/></button>}
  </div>;
}
