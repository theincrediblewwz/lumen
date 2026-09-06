import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 右键菜单项：分隔线 / 只读信息项 / 可点动作项 */
export type MenuItem =
  | { type: 'separator' }
  | { type: 'info'; text: string; sub?: string }
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
  }, [state]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
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
    </div>
  );
}
