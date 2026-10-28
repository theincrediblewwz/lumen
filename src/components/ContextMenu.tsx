import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 右键菜单项：分隔线 / 只读信息项 / 可点动作项 */
export type MenuItem =
  | { type: 'separator' }
  | { type: 'info'; text: string; sub?: string }
  | { type: 'group'; label: string; disabled?: boolean; items: Extract<MenuItem, { type: 'item' }>[] }
  | { type: 'item'; label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * 轻量右键/浮层菜单（自研，零依赖）。
 * - fixed 定位到 (x,y)，挂载后按实际尺寸夹进视口，避免溢出屏幕
 * - 点击外部 / Esc / 窗口 resize / blur 自动关闭
 */
export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y, ready: false });

  // 防溢出：布局后测量实际尺寸再定位（首帧不可见，避免闪跳）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(pad, Math.min(state.x, window.innerWidth - width - pad));
    const y = Math.max(pad, Math.min(state.y, window.innerHeight - height - pad));
    setPos({ x, y, ready: true });
  }, [state, expanded]);

  useEffect(() => { setExpanded(null); }, [state]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); onClose();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!items.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`ctx-menu${state.items.some(item => item.type === 'group') ? ' has-groups' : ''}`}
      role="menu"
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.items.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="ctx-sep" />;
        if (it.type === 'info')
          return (
            <div key={i} className="ctx-info">
              <span className="ctx-info-text">{it.text}</span>
              {it.sub && <span className="ctx-info-sub">{it.sub}</span>}
            </div>
          );
        if (it.type === 'group') return <div key={i} className="ctx-group">
          <button type="button" role="menuitem" className="ctx-item ctx-group-toggle" disabled={it.disabled}
            aria-expanded={expanded === i} onClick={() => setExpanded(expanded === i ? null : i)}>
            <span>{it.label}</span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={expanded === i ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {expanded === i && <div className="ctx-group-items" role="group" aria-label={it.label}>{it.items.map((child, index) => <button key={index} type="button" role="menuitem" className={`ctx-item${child.danger ? ' is-danger' : ''}`} disabled={child.disabled} onClick={() => { onClose(); child.onClick(); }}>{child.label}</button>)}</div>}
        </div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
