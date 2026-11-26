import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardNode } from '../api';
import { DEFAULT_HEAT_LABEL_COLOR, HEAT_LABEL_NAME_LIMIT, HEAT_LABEL_SIZE, readHeatLabel, type HeatLabel } from '../canvas/presentation';
import { HeatLabelText } from './HeatOverview';

function draftFor(node: BoardNode): HeatLabel {
  return readHeatLabel(node.heatLabel) ?? {
    name: Array.from(node.title.trim()).slice(0, HEAT_LABEL_NAME_LIMIT).join(''),
    color: /^#[\da-f]{6}$/i.test(node.color ?? '') ? node.color! : DEFAULT_HEAT_LABEL_COLOR,
    fontSize: HEAT_LABEL_SIZE.default,
  };
}

export function HeatLabelEditor({ candidates, onClose, onSave }: {
  candidates: BoardNode[]; onClose: () => void; onSave: (id: string, label: HeatLabel | undefined) => boolean;
}) {
  const title = useId();
  const card = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [nodeId, setNodeId] = useState(candidates[0].id);
  const [draft, setDraft] = useState(() => draftFor(candidates[0]));
  const [error, setError] = useState(false);
  const node = candidates.find(candidate => candidate.id === nodeId) ?? candidates[0];
  const valid = readHeatLabel(draft);
  const canRemove = !!readHeatLabel(node.heatLabel);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    const keys = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...(card.current?.querySelectorAll<HTMLElement>('input, select, button:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener('keydown', keys, true);
    return () => {
      window.removeEventListener('keydown', keys, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  function save(label: HeatLabel | undefined) {
    if (onSave(node.id, label)) onClose();
    else setError(true);
  }

  return createPortal(<div className="settings-overlay" onMouseDown={onClose} onPointerDown={event => event.stopPropagation()}>
    <form ref={card} className="settings-card heat-label-editor" role="dialog" aria-modal="true" aria-labelledby={title}
      onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (valid) save(valid); }}>
      <h2 id={title}>热力名称</h2>
      {candidates.length > 1 && <label className="heat-label-field">节点
        <select className="input" value={node.id} onChange={event => {
          const chosen = candidates.find(candidate => candidate.id === event.target.value)!;
          setNodeId(chosen.id); setDraft(draftFor(chosen)); setError(false);
        }}>
          {candidates.map((candidate, index) => <option key={candidate.id} value={candidate.id}>
            {index + 1}. {candidate.title.trim() || '无标题节点'}{candidate.heatLabel ? ` · ${candidate.heatLabel.name}` : ''}
          </option>)}
        </select>
      </label>}
      <label className="heat-label-field">名称<input ref={input} className="input" placeholder="输入热力名称" value={draft.name}
        onChange={event => setDraft({ ...draft, name: Array.from(event.target.value).slice(0, HEAT_LABEL_NAME_LIMIT).join('') })} /></label>
      <div className="heat-label-options">
        <label className="heat-label-color">荧光颜色<input type="color" value={draft.color}
          onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
        <label className="heat-label-size">字号 <output>{draft.fontSize} px</output>
          <input type="range" aria-label="字号" min={HEAT_LABEL_SIZE.min} max={HEAT_LABEL_SIZE.max} value={draft.fontSize}
            onChange={event => setDraft({ ...draft, fontSize: Number(event.target.value) })} /></label>
      </div>
      <div className="heat-label-sample" aria-label="荧光预览"><HeatLabelText label={{ ...draft, name: draft.name.trim() || '名称预览' }}/></div>
      {error && <p className="error-text" role="alert">当前无法保存，请确认节点仍存在，或等待同步完成后重试。</p>}
      <footer className="action-confirm-buttons">
        {canRemove && <button className="btn heat-label-remove" type="button" onClick={() => save(undefined)}>移除名称</button>}
        <button className="btn" type="button" onClick={onClose}>取消</button>
        <button className="btn btn-primary" type="submit" disabled={!valid}>保存</button>
      </footer>
    </form>
  </div>, document.body);
}
