import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** App-owned confirmation works in WKWebView without JavaScript dialog delegates. */
export function ConfirmAction({ message, onCancel, onConfirm, confirmLabel = '确认删除' }: { message: string; onCancel: () => void; onConfirm: () => void; confirmLabel?: string }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      // Isolate the modal from app shortcuts and WebKit's Backspace navigation.
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      else if (event.key === 'Tab') {
        const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      } else if (event.key !== 'Enter' && event.key !== ' ') event.preventDefault();
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, [onCancel]);
  return createPortal(<div className="settings-overlay" onMouseDown={onCancel}>
    <div ref={card} className="settings-card action-confirm" role="alertdialog" aria-modal="true" aria-label={message} onMouseDown={event => event.stopPropagation()}>
      <p>{message}</p><div className="action-confirm-buttons"><button className="btn" onClick={onCancel}>取消</button><button className="btn" onClick={onConfirm}>{confirmLabel}</button></div>
    </div>
  </div>, document.body);
}
