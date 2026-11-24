import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { DocRef } from '../api';
import { imageDoc } from '../canvas/composition';
import { stepPreview, type PreviewPosition } from '../canvas/preview';
import { NodeAttachment, DocumentPages } from './NodeAttachment';

export type PreviewPresentation = { resourceKey: string; image: boolean; navigated: boolean; title: string; dimensions?: { width: number; height: number } };
type PreviewResource = { key: string; title: string } & ({ summary: string } | { doc: DocRef });
export type PreviewMemory = Map<string, { signature: string; position: PreviewPosition; counts: Partial<Record<string, number>>; navigated: boolean }>;
type PreviewProps = {
  summary?: string | null; docs: DocRef[]; projectId: string; boardId: string; docVersions: Record<string, number>;
  onPresentation: (value: PreviewPresentation) => void; viewKey: string; memory?: PreviewMemory;
};
const positions: PreviewMemory = new Map();

export function copyPreviewMemory(projectId: string, boardId: string): PreviewMemory {
  const prefix = `${projectId}/${boardId}/`;
  return new Map([...positions].filter(([key]) => key.startsWith(prefix)));
}

export function NodePreview({ summary, docs, onPresentation, viewKey, ...context }: PreviewProps) {
  const attachments = useMemo(() => docs.map(doc => ({ key: doc.path, title: doc.title, doc })), [docs]);
  return <>
    {!!summary?.trim() && <PreviewPager {...context} resources={[{ key: 'question', title: '完整问题', summary }]} viewKey={`${viewKey}/question`}
      onPresentation={attachments.length ? undefined : onPresentation} />}
    {attachments.length > 0 && <PreviewPager {...context} resources={attachments} viewKey={`${viewKey}/attachments`} onPresentation={onPresentation} />}
  </>;
}

function PreviewPager({ resources, projectId, boardId, docVersions, onPresentation, viewKey, memory = positions }: Omit<PreviewProps, 'summary' | 'docs' | 'onPresentation'> & {
  resources: PreviewResource[];
  onPresentation?: PreviewProps['onPresentation'];
}) {
  const signature = resources.map(r => r.key).join('\n'), cached = memory.get(viewKey), saved = cached?.signature === signature ? cached : undefined;
  const [position, setPosition] = useState(saved?.position ?? { resource: 0, page: 0 }), [navigated, setNavigated] = useState(saved?.navigated ?? false);
  const counts = useRef<Partial<Record<string, number>>>({ ...saved?.counts });
  const [measuredPages, setPages] = useState(saved?.counts[resources[saved.position.resource]?.key]);
  const resourceIndex = Math.min(position.resource, resources.length - 1);
  const resource = resources[resourceIndex];
  const previousButton = useRef<HTMLButtonElement>(null), nextButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<-1 | 1>();
  const [dimensions, setDimensions] = useState<{ key: string; width: number; height: number }>();
  const key = resource.key, image = 'doc' in resource && imageDoc(resource.doc);
  const previousSignature = useRef(signature);
  useLayoutEffect(() => {
    if (previousSignature.current === signature) return;
    const oldKeys = previousSignature.current.split('\n');
    const current = oldKeys[position.resource], primary = resources[0].key;
    const promoted = primary !== oldKeys[0] && oldKeys.includes(primary);
    const target = Math.max(0, resources.findIndex(r => r.key === (promoted ? primary : current)));
    const nextKey = resources[target].key;
    previousSignature.current = signature;
    setPosition({ resource: target, page: nextKey === current ? position.page : 0 });
    setPages(counts.current[nextKey]);
    if (promoted) setNavigated(true);
  }, [signature]);
  useEffect(() => {
    memory.delete(viewKey); memory.set(viewKey, { signature, position, counts: { ...counts.current }, navigated });
    while (memory.size > 512) memory.delete(memory.keys().next().value!);
  }, [memory, viewKey, signature, position, measuredPages, navigated]);
  const onPages = useCallback((total: number) => { counts.current[key] = total; setPages(old => old === total ? old : total);setPosition(old=>old.page<total?old:{...old,page:total-1}); }, [key]);
  const onImageSize = useCallback((size: { width: number; height: number }) => setDimensions(old => old?.key === key && old.width === size.width && old.height === size.height ? old : { key, ...size }), [key]);
  useLayoutEffect(() => onPresentation?.({ resourceKey:key, image, navigated, title: resource.title, dimensions: dimensions?.key === key ? dimensions : undefined }), [image, navigated, resource.title, key, dimensions, onPresentation]);
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      (restoreFocus.current < 0 ? previousButton : nextButton).current?.focus({ preventScroll: true });
      restoreFocus.current = undefined;
    }
  }, [position]);
  const total = image ? 1 : measuredPages;
  const pages = total ?? 1;
  const page = Math.min(position.page, pages - 1);
  const canGoBack = resourceIndex > 0 || page > 0;
  const canGoForward = total !== undefined && (page + 1 < pages || resourceIndex + 1 < resources.length);
  const hasPager = resources.length > 1 || pages > 1;
  const turn = (direction: -1 | 1) => {
    if (direction > 0 ? !canGoForward : !canGoBack) return;
    const pageCounts = resources.map(r => 'doc' in r && imageDoc(r.doc) ? 1 : counts.current[r.key] ?? 1);
    const next = stepPreview(position, pageCounts, direction);
    if (next.resource === position.resource && next.page === position.page) return;
    if (!next.resource && !next.page && document.activeElement === previousButton.current) restoreFocus.current = 1;
    if (next.resource === resources.length - 1 && next.page === pageCounts[next.resource] - 1
      && document.activeElement === nextButton.current) restoreFocus.current = -1;
    setNavigated(true); setPosition(next); setPages(counts.current[resources[next.resource].key]);
  };
  const question = 'summary' in resource;
  const pageButton = (direction: -1 | 1) => {
    const backwards = direction < 0;
    const changesMaterial = backwards ? page === 0 : page === pages - 1;
    const label = backwards ? (changesMaterial ? '上一个素材' : '上一页') : (changesMaterial ? '下一个素材' : '下一页');
    const Chevron = backwards ? (changesMaterial ? ChevronsLeft : ChevronLeft) : (changesMaterial ? ChevronsRight : ChevronRight);
    return <button type="button" ref={backwards ? previousButton : nextButton}
      className={`node-preview-turn ${backwards ? 'node-preview-previous' : 'node-preview-next'}${changesMaterial ? ' is-material-turn' : ''} glass-surface`}
      aria-label={label} title={label}
      onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }}
      onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); turn(e.shiftKey ? -1 : direction); }}
      onKeyDown={e => {
        if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); turn(['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1);
        }
      }}><Chevron size={14} aria-hidden="true" /></button>;
  };
  return <div className={`node-preview${image ? ' is-image' : ''}${question ? ' is-question' : ''}${hasPager ? ' has-page-controls' : ''}`}
    role="group" aria-label={question ? '完整问题预览' : '附件预览'}
    onPointerEnter={event => {
      if (event.pointerType !== 'touch') event.currentTarget.setAttribute('data-preview-hover', '');
    }}
    onPointerLeave={event => event.currentTarget.removeAttribute('data-preview-hover')}
    data-preview-resource={resource.key} data-preview-index={resourceIndex} data-preview-page={page} data-preview-pages={pages}>
    {'doc' in resource ? <NodeAttachment key={resource.key} projectId={projectId} boardId={boardId} doc={resource.doc} refresh={docVersions[resource.key] ?? 0} page={page} onPages={onPages} onImageSize={onImageSize}/>
      : <DocumentPages key={resource.key} markdown={resource.summary ?? ''} page={page} onPages={onPages} question/>}
    {canGoBack && pageButton(-1)}
    {hasPager && <div className="node-preview-progress" role="status"
      aria-label={`${question ? '' : `第 ${resourceIndex + 1} 个素材，`}${total === undefined ? '正在读取页码' : `第 ${page + 1} 页，共 ${pages} 页`}`}>
      {!question && <span className="node-preview-material-number" aria-hidden="true">{resourceIndex + 1}</span>}
      <span className="node-preview-page-number" aria-hidden="true">{page + 1}/{total ?? '…'}</span>
    </div>}
    {canGoForward && pageButton(1)}
  </div>;
}
