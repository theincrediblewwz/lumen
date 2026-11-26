import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react';
import { createPortal } from 'react-dom';

type Props = ComponentPropsWithoutRef<'button'> & { hint: string; buttonRef?: Ref<HTMLButtonElement> };

export function TitleBarButton({ hint, buttonRef, children, onFocus, onBlur, ...button }: Props) {
  const id = useId();
  const control = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [anchor, setAnchor] = useState<{ surface: HTMLElement; top: number; right: number }>();
  const open = (hovered || keyboardFocus) && String(button['aria-expanded']) !== 'true';

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = control.current;
      const surface = trigger?.closest<HTMLElement>('.board-surface');
      if (!trigger || !surface) return;
      const bounds = trigger.getBoundingClientRect();
      const frame = surface.getBoundingClientRect();
      setAnchor({ surface, top: bounds.bottom - frame.top + 7, right: Math.max(12, frame.right - bounds.right) });
    };
    const dismiss = () => { setHovered(false); setKeyboardFocus(false); };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('blur', dismiss);
    };
  }, [open, hint]);

  return <>
    <span className="titlebar-control" ref={control} onPointerEnter={e => { if (e.pointerType !== 'touch') setHovered(true); }} onPointerLeave={() => setHovered(false)}>
      <button type="button" {...button} ref={buttonRef} aria-describedby={anchor ? id : undefined}
        onFocus={e => { setKeyboardFocus(e.currentTarget.matches(':focus-visible')); onFocus?.(e); }}
        onBlur={e => { setKeyboardFocus(false); onBlur?.(e); }}>{children}</button>
    </span>
    {anchor && createPortal(<span className={`titlebar-hint${open ? ' is-visible' : ''}`} id={id} role="tooltip"
      style={{ top: anchor.top, right: anchor.right }}>{hint}</span>, anchor.surface)}
  </>;
}
