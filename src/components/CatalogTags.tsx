import { Check, Eye, EyeOff, Plus, Tag } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CatalogTag, TagDefinition } from '../projectCanvas/tags';
import { TitleBarButton } from './TitleBarButton';
import '../projectCanvas/tags.css';

function Dot({ color }: { color: string }) {
  return <span className="catalog-tag-dot" style={{ backgroundColor: color }} aria-hidden="true" />;
}

export function TagDots({ tags }: { tags: CatalogTag[] }) {
  if (!tags.length) return null;
  const names = tags.map(tag => tag.name).join('、');
  return <span className="catalog-tag-dots" role="img" aria-label={`标签：${names}`} title={names}>
    {tags.map(tag => <Dot key={tag.id} color={tag.color} />)}
  </span>;
}

type FilterProps = {
  tags: CatalogTag[];
  active: ReadonlySet<string>;
  onChange: (ids: string[]) => void;
};

export function TagFilter({ tags, active, onChange }: FilterProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = toggle.current?.getBoundingClientRect();
      if (bounds) setPosition({ top: bounds.bottom + 7, right: Math.max(8, window.innerWidth - bounds.right) });
    };
    place();
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  return <div ref={anchor} className="catalog-tag-filter">
    <TitleBarButton buttonRef={toggle} className={`titlebar-btn titlebar-menu${active.size ? ' catalog-filter-active' : ''}`}
      hint="按标签筛选当前画布的内容" aria-label="按标签筛选" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}>
      {active.size ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
    </TitleBarButton>
    {open && createPortal(<section ref={panel} className="catalog-filter-panel" id={menuId} style={position} aria-label="标签筛选选项">
      <button className="catalog-tag-option" type="button" aria-pressed={!active.size} onClick={() => onChange([])}>
        <Eye size={15} /><span>全部内容</span>{!active.size && <Check size={15} />}
      </button>
      <div className="catalog-filter-options">
        {tags.map(tag => <button key={tag.id} type="button" className="catalog-tag-option" aria-pressed={active.has(tag.id)} onClick={() => {
          const next = new Set(active);
          if (next.has(tag.id)) next.delete(tag.id);
          else next.add(tag.id);
          onChange([...next]);
        }}>
          <Dot color={tag.color} /><span>{tag.name}</span>{active.has(tag.id) && <Check size={15} />}
        </button>)}
      </div>
    </section>, document.body)}
  </div>;
}

type EditorProps = {
  title: string;
  tags: CatalogTag[];
  assigned: string[];
  colorMark?: string;
  onClose: () => void;
  onSave: (ids: string[], definitions: Record<string, TagDefinition>) => Promise<void>;
};

export function TagEditor({ title, tags, assigned, colorMark, onClose, onSave }: EditorProps) {
  const [selected, setSelected] = useState(() => new Set(assigned));
  const [added, setAdded] = useState<CatalogTag[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3a9d5d');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const formTitle = useId();
  const colorTitle = useId();
  const card = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const busy = useRef(false);
  const savedIds = new Set(tags.map(tag => tag.id));
  const choices = [...tags, ...added.filter(tag => !savedIds.has(tag.id))];

  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const original = opener.current;
    return () => { if (original?.isConnected) original.focus(); };
  }, []);

  function toggle(tagId: string) {
    setSelected(old => {
      const next = new Set(old);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function create(): CatalogTag | undefined {
    const label = name.trim();
    if (!label) { setError('请输入标签名称。'); return; }
    if (choices.some(tag => tag.name.toLowerCase() === label.toLowerCase())) {
      setError('已有同名标签，请从列表里选择。');
      return;
    }
    const tag = { id: `tag_${crypto.randomUUID().replaceAll('-', '')}`, name: label, color };
    setAdded(old => [...old, tag]);
    setSelected(old => new Set([...old, tag.id]));
    setCreating(false);
    setName('');
    setError('');
    return tag;
  }

  async function save() {
    if (busy.current) return;
    const pending = creating && name.trim() ? create() : undefined;
    if (creating && name.trim() && !pending) return;
    const nextTags = pending ? [...added, pending] : added;
    const allIds = pending ? [...selected, pending.id] : [...selected];
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(allIds, Object.fromEntries(nextTags.map(({ id, name, color }) => [id, { name, color }])));
      onClose();
    } catch (error) {
      setError(String(error).replace(/^Error:\s*/, ''));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return <div className="catalog-tag-overlay" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy.current) {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const fields = [...(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      const index = fields.indexOf(document.activeElement as HTMLElement);
      if (!fields.length || (event.shiftKey ? index <= 0 : index < 0 || index === fields.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? fields.at(-1) : fields[0])?.focus();
      }
    }
  }}>
    <section ref={card} className="catalog-tag-dialog glass-surface" role="dialog" aria-modal="true" aria-labelledby={formTitle}>
      <header>
        <Tag size={17} />
        <h2 id={formTitle}>编辑标签</h2>
      </header>
      <p className="catalog-tag-subject">{title || '节点'}</p>
      <div className="catalog-tag-choices" aria-label="标签" role="group">
        {choices.map(tag => <button type="button" key={tag.id}
          className="catalog-tag-choice" aria-pressed={selected.has(tag.id) || colorMark === tag.id}
          disabled={saving || colorMark === tag.id}
          title={colorMark === tag.id ? '随节点颜色标记' : tag.name} onClick={() => toggle(tag.id)}>
          <Dot color={tag.color} />{tag.name}
          {(selected.has(tag.id) || colorMark === tag.id) && <Check size={13} />}
        </button>)}
      </div>
      {creating ? <form className="catalog-tag-create" onSubmit={event => { event.preventDefault(); create(); }}>
        <input className="input" autoFocus value={name} disabled={saving} maxLength={40}
          aria-label="标签名称" placeholder="标签名称" onChange={event => setName(event.target.value)} />
        <label id={colorTitle} className="catalog-tag-color">
          <span>颜色</span><input type="color" value={color} disabled={saving}
            aria-labelledby={colorTitle} onChange={event => setColor(event.target.value)} />
        </label>
        <button type="submit" className="ai-btn-secondary" disabled={saving}>添加</button>
      </form> : <button className="ai-btn-secondary catalog-tag-new" type="button" disabled={saving} onClick={() => setCreating(true)}>
        <Plus size={15} />新建标签
      </button>}
      {error && <p className="catalog-tag-error" role="alert">{error}</p>}
      <footer className="action-confirm-buttons">
        <button type="button" className="ai-btn-secondary" disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className="ai-btn-primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </footer>
    </section>
  </div>;
}
