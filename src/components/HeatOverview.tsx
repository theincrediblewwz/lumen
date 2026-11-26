import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { worldToScreen, type Viewport } from '../canvas/CanvasEngine';
import { flowHighlight } from '../canvas/preview';
import type { HeatCell, HeatLabel } from '../canvas/presentation';

export function HeatLabelText({ label, children, size = label.fontSize }: { label: HeatLabel; children?: ReactNode; size?: number }) {
  return <span className="heat-label-text" style={{ '--heat-label-color': label.color, fontSize: size } as CSSProperties}>
    {children ?? label.name}
  </span>;
}

type Popup = { cellId: string; trigger: HTMLButtonElement; x: number; focus: boolean };

export function HeatOverview({ cells, level, viewport, description, onExpand, onLocate, onEdit }: {
  cells: HeatCell[]; level: number; viewport: Viewport; description: string;
  onExpand: (cell: HeatCell) => void;
  onLocate: (nodeId: string, grouped: boolean) => void;
  onEdit?: (cell: HeatCell, event: MouseEvent) => void;
}) {
  const id = useId();
  const [popup, setPopup] = useState<Popup | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const members = popup ? cells.find(cell => cell.id === popup.cellId)?.labels : undefined;

  function clearClose() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function closeSoon() {
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (!list.current?.contains(document.activeElement)) setPopup(null);
    }, 200);
  }
  function open(cellId: string, trigger: HTMLButtonElement, x: number, focus = false) {
    clearClose();
    setPopup(previous => previous?.cellId === cellId && !focus ? previous : { cellId, trigger, x, focus });
  }

  useLayoutEffect(() => { setPopup(null); clearClose(); }, [viewport.x, viewport.y, viewport.zoom]);
  useEffect(() => clearClose, []);
  useLayoutEffect(() => {
    const el = list.current;
    if (!popup || !el) return;
    el.style.maxHeight = '';
    const trigger = popup.trigger.getBoundingClientRect();
    const pad = 8, gap = 6;
    const below = window.innerHeight - trigger.bottom - gap - pad;
    const above = trigger.top - gap - pad;
    const openAbove = el.offsetHeight > below && above > below;
    el.style.maxHeight = `${Math.min(el.offsetHeight, Math.max(60, openAbove ? above : below))}px`;
    el.style.left = `${Math.max(pad, Math.min(popup.x - 20, window.innerWidth - el.offsetWidth - pad))}px`;
    el.style.top = `${Math.max(pad, openAbove ? trigger.top - gap - el.offsetHeight : trigger.bottom + gap)}px`;
    if (popup.focus) el.querySelector('button')?.focus({ preventScroll: true });
  }, [popup, members]);
  useEffect(() => {
    if (!popup) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !popup.trigger.contains(target)) setPopup(null);
    };
    const close = () => setPopup(null);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [popup]);

  return <>
    <div className="heat-layer" aria-label={description} data-level={level}>
      {cells.map(cell => {
        const at = worldToScreen(viewport, cell);
        const single = cell.labels.length === 1 ? cell.labels[0] : undefined;
        const named = cell.labels.length > 0;
        const active = popup?.cellId === cell.id && cell.labels.length > 1;
        const labelPoint = single ? worldToScreen(viewport, single) : null;
        const counts = `${cell.count} 个节点${cell.flowCount ? ` · ${cell.flowCount} 个含子流程` : ''}`;
        return <div className={`heat-region${active ? ' is-active' : ''}`} key={cell.id}
          style={{ left: at.x, top: at.y, width: Math.max(8, cell.w * viewport.zoom), height: Math.max(8, cell.h * viewport.zoom) }}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation(); setPopup(null); onEdit?.(cell, event);
          }}>
          <button type="button" className={`heat-cell${cell.flowCount ? ' has-flow' : ''}${named ? ' has-heat-name' : ''}`}
            data-count={cell.count} data-flow-count={cell.flowCount} title={`${counts} · 点击逐级放大`}
            aria-label={`放大包含 ${counts} 的热力区域`} style={{
              opacity: cell.flowCount ? 1 : Math.min(.95, .45 + Math.log2(cell.count + 1) * .08),
              '--heat-color': cell.color || 'var(--accent)', '--flow-glow': flowHighlight(cell.flowColor),
            } as CSSProperties} onClick={event => { event.stopPropagation(); onExpand(cell); }}
            onKeyDown={event => {
              if (onEdit && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
              }
            }}>
            {cell.count > 1 && <span className="heat-cell-count">{cell.count}</span>}
          </button>
          {single && <button type="button" className="heat-label-anchor" data-heat-node={single.nodeId}
            title={`定位到 ${single.name}`} style={{ left: labelPoint!.x - at.x, top: labelPoint!.y - at.y }}
            onClick={event => { event.stopPropagation(); onLocate(single.nodeId, false); }}>
            <HeatLabelText label={single}/>
          </button>}
          {cell.labels.length > 1 && <button type="button" className="heat-label-anchor heat-label-summary"
            aria-haspopup="dialog" aria-expanded={active} aria-controls={active ? id : undefined}
            onPointerEnter={event => open(cell.id, event.currentTarget, event.clientX)} onPointerLeave={closeSoon}
            onClick={event => {
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              open(cell.id, event.currentTarget, event.detail ? event.clientX : box.left + box.width / 2, !event.detail);
            }} onKeyDown={event => { if (event.key === 'Escape' && active) { event.stopPropagation(); setPopup(null); } }}>
            <HeatLabelText label={cell.labels[0]} size={16}>{cell.labels.length} 个重要节点</HeatLabelText>
          </button>}
        </div>;
      })}
    </div>
    {popup && members && members.length > 1 && createPortal(<div id={id} ref={list}
      className="heat-label-list" role="dialog" aria-label="重要节点" onPointerEnter={clearClose} onPointerLeave={closeSoon}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeSoon(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); setPopup(null); popup.trigger.focus({ preventScroll: true }); }
      }}>
      {members.map(label => <button type="button" key={label.nodeId} onClick={event => {
        event.stopPropagation(); setPopup(null); onLocate(label.nodeId, true);
      }}><HeatLabelText label={label}/></button>)}
    </div>, document.body)}
  </>;
}
