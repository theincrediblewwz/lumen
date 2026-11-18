import { Check, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { coverPreset, COVER_PRESETS } from '../projectCanvas/coverPresets';
import type { CoverTarget } from '../projectCanvas/covers';
import { ProjectTileArtwork } from './ProjectTileArtwork';
import '../projectCanvas/coverPicker.css';

export function ProjectCoverPicker({ name, kind, current, onClose, onSave }: {
  name: string;
  kind: CoverTarget['kind'];
  current: string | null;
  onClose: () => void;
  onSave: (coverId: string | null) => Promise<void>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [selected, setSelected] = useState(coverPreset(current)?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { closeButton.current?.focus(); }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!pending.current) onClose();
      } else if (event.key === 'Tab') {
        const fields = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked:not(:disabled)') ?? [])];
        const current = fields.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey ? current <= 0 : current < 0 || current === fields.length - 1) {
          event.preventDefault();
          (event.shiftKey ? fields.at(-1) : fields[0])?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  function close() {
    if (!pending.current) onClose();
  }

  async function save() {
    if (pending.current || selected === current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(selected);
      onClose();
    } catch (error) {
      setError(String(error).replace(/^Error:\s*/, ''));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <div className="settings-overlay cover-picker-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) close();
  }}>
    <form ref={dialog} className="settings-card cover-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onSubmit={event => { event.preventDefault(); void save(); }}
      onKeyDown={event => event.stopPropagation()}>
      <header className="cover-picker-head">
        <div>
          <h2 id={titleId}>更换封面</h2>
          <p title={name}>{name}</p>
        </div>
        <button ref={closeButton} type="button" aria-label="关闭封面选择" className="cover-picker-close" disabled={saving} onClick={close}>
          <X size={21} aria-hidden="true" />
        </button>
      </header>
      <fieldset className="cover-picker-scroll" aria-label="可选封面" disabled={saving}>
        <div className="cover-picker-grid">
          {[null, ...COVER_PRESETS].map(cover => {
            const id = cover?.id ?? null;
            const checked = selected === id;
            return <label key={id ?? 'default'} className="cover-option">
              <input type="radio" name={titleId + '-choice'} value={id ?? ''} checked={checked}
                onChange={event => {
                  event.currentTarget.focus({ preventScroll: true });
                  setSelected(id);
                  setError('');
                }} />
              <span className="cover-option-card">
                <span className="cover-option-art" aria-hidden="true">
                  {cover?.kind === 'photo' ? <img src={cover.url} alt="" width={720} height={405} loading="lazy" decoding="async" draggable={false} />
                    : <span className="cover-option-skin"><ProjectTileArtwork kind={kind} cover={cover ?? undefined} /></span>}
                  {checked && <span className="cover-option-check"><Check size={15} strokeWidth={2.5} /></span>}
                </span>
                <span className="cover-option-label">{cover?.name ?? '默认封面'}</span>
              </span>
            </label>;
          })}
        </div>
      </fieldset>
      <footer className="cover-picker-footer">
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={saving || selected === current}>
          {saving ? '保存中…' : '应用封面'}
        </button>
      </footer>
    </form>
  </div>;
}
