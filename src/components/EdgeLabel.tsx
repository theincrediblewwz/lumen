import { MarkdownView } from './MarkdownView';

export function EdgeLabel({ label, x, y, zoom, onSelect, onEdit }: {
  label: string; x: number; y: number; zoom: number; onSelect?: () => void; onEdit?: () => void;
}) {
  const name = `连线说明：${label}`;
  if (zoom < .6) {
    const dots = <><i /><i /><i /></>;
    return onSelect
      ? <button className="edge-label-hint" style={{ left: x, top: y }} aria-label={name} title={label}
          onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSelect(); }}
          onDoubleClick={event => { event.stopPropagation(); onEdit?.(); }}>{dots}</button>
      : <span className="edge-label-hint is-passive" style={{ left: x, top: y }} role="img" aria-label={name}>{dots}</span>;
  }
  return <div className={`edge-label-rendered${onSelect ? '' : ' is-passive'}`}
    role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={name}
    style={{ left: x, top: y, transform: `translate(-50%,-50%) scale(${zoom})` }}
    onPointerDown={onSelect && (event => event.stopPropagation())}
    onClick={onSelect && (event => { event.stopPropagation(); onSelect(); })}
    onDoubleClick={onEdit && (event => { event.stopPropagation(); onEdit(); })}
    onKeyDown={onEdit && (event => { if (event.key === 'Enter') { event.stopPropagation(); onEdit(); } })}>
    <MarkdownView value={label} inline />
  </div>;
}
