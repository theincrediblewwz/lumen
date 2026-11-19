import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Highlighter } from 'lucide-react';
import { DEFAULT_HIGHLIGHT, highlightColor, highlightMarkup } from '../reader/highlight';

const RECENT_COLOR = 'lumen.markdown.highlight-color';
const PRESETS = [
  ['荧光黄', DEFAULT_HIGHLIGHT], ['荧光绿', '#82FF6B'], ['浅蓝', '#5CEAFF'],
  ['桃粉', '#FF85C5'], ['浅紫', '#BE9DFF'], ['橙色', '#FFC265'],
] as const;

type Selection = {
  field: HTMLTextAreaElement;
  source: string;
  start: number;
  end: number;
  x: number;
  y: number;
};

export function useSelectionHighlight(onChange: (value: string) => void) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [palette, setPalette] = useState(false);
  const [color, setColor] = useState(DEFAULT_HIGHLIGHT);
  const toolbar = useRef<HTMLDivElement>(null);
  const frame = useRef<number>();

  useEffect(() => () => cancelAnimationFrame(frame.current ?? 0), []);

  const close = () => setSelection(null);
  useEffect(() => {
    if (!selection) return;
    const outside = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.target === selection.field && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
        close();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
    };
  }, [selection]);

  const onMouseUp = (event: MouseEvent<HTMLTextAreaElement>) => {
    if (event.button !== 0) return;
    const field = event.currentTarget;
    const { clientX: x, clientY: y } = event;
    cancelAnimationFrame(frame.current ?? 0);
    frame.current = requestAnimationFrame(() => {
      if (!field.isConnected || document.activeElement !== field) return;
      const { selectionStart: start, selectionEnd: end, value: source } = field;
      const selected = source.slice(start, end);
      if (!selected.trim() || /[\r\n]/.test(selected)) { close(); return; }
      try { setColor(highlightColor(localStorage.getItem(RECENT_COLOR)) ?? DEFAULT_HIGHLIGHT); }
      catch { /* The in-memory color still works with storage disabled. */ }
      setPalette(false);
      setSelection({ field, start, end, source, x, y });
    });
  };

  const choose = (value: string) => {
    setColor(value);
    try { localStorage.setItem(RECENT_COLOR, value); } catch { /* Color is also held in state. */ }
  };

  const apply = () => {
    if (!selection) return;
    const { field, start, end, source } = selection;
    close();
    if (!field.isConnected || field.value !== source) return;
    const markup = highlightMarkup(source.slice(start, end), color);
    const value = `${source.slice(0, start)}${markup}${source.slice(end)}`;
    onChange(value);
    frame.current = requestAnimationFrame(() => {
      if (!field.isConnected || field.value !== value) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(start + markup.length, start + markup.length);
    });
  };

  const above = !!selection && selection.y >= (palette ? 130 : 58);
  const menu = selection && createPortal(
    <div ref={toolbar} className={`selection-highlight glass-surface${above ? ' is-above' : ''}`}
      style={{ left: Math.max(8, Math.min(window.innerWidth - 207, selection.x - 62)), top: selection.y + (above ? -10 : 10) }}
      role="group" aria-label="选中文字"
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="selection-highlight-actions">
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={apply}>
          <Highlighter size={15} aria-hidden="true"/>高亮
        </button>
        <button type="button" aria-label="高亮颜色" title="高亮颜色" aria-expanded={palette}
          onMouseDown={event => event.preventDefault()} onClick={() => setPalette(!palette)}>
          <span className="highlight-swatch" style={{ backgroundColor: color }}/><ChevronDown size={13} aria-hidden="true"/>
        </button>
      </div>
      {palette && <div className="selection-highlight-colors">
        {PRESETS.map(([name, value]) => <button key={value} type="button" aria-label={name} title={name}
          aria-pressed={color === value} className="highlight-swatch" style={{ backgroundColor: value }}
          onMouseDown={event => event.preventDefault()} onClick={() => { choose(value); setPalette(false); }}/>) }
        <label className="highlight-custom">自选颜色<input type="color" aria-label="自选高亮颜色" value={color}
          onChange={event => choose(event.target.value.toUpperCase())}/></label>
      </div>}
    </div>, document.body);

  return { onMouseUp, menu };
}
