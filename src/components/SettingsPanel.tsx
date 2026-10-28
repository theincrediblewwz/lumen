import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Settings, ThemeName, GlassMode, EdgeStyle } from '../settings';
import { SyncSettings } from './SyncSettings';
import { BoardWriteSettings } from './BoardWriteSettings';

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'paper', label: '纸感' },
  { id: 'dark', label: '深色' },
];

const GLASS_MODES: { id: GlassMode; label: string }[] = [
  { id: 'native', label: '原生' },
  { id: 'css', label: '网页' },
  { id: 'off', label: '关闭' },
];

const EDGE_STYLES: { id: EdgeStyle; label: string }[] = [
  { id: 'curved', label: '曲线' },
  { id: 'straight', label: '直线' },
  { id: 'stepped', label: '折线' },
];

/**
 * 设置面板：主题、液态玻璃开关与通透度/模糊、动画开关。
 * 以玻璃卡片形式居中浮出；点击遮罩或 Esc 关闭。
 */
export function SettingsPanel({
  settings,
  platform,
  storageRoot,
  storageBusy,
  onChooseStorage,
  onChange,
  onClose,
}: {
  settings: Settings;
  platform: string;
  storageRoot: string | null;
  storageBusy: boolean;
  onChooseStorage: () => void;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const isMac = platform === 'macos';
  const effectiveGlassMode = !settings.glass || (settings.glassMode === 'native' && !isMac) ? 'off' : settings.glassMode;
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLButtonElement>('.settings-close')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,select:not(:disabled),a[href]') ?? []).filter(el => el.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, []);

  return createPortal(
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        ref={card}
        className="settings-card settings-preferences glass-surface"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2>设置</h2>
          <button type="button" className="settings-close" title="关闭 (Esc)" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
        <BoardWriteSettings/>
        <section className="settings-section settings-storage">
          <div className="settings-row"><h3 className="settings-label">保存位置</h3><button type="button" className="btn" disabled={storageBusy} onClick={onChooseStorage}>更改目录</button></div>
          <p className="settings-storage-path" title={storageRoot ?? undefined}>{storageRoot ?? '尚未选择保存目录'}</p>
          <p className="settings-hint">白板、文档和知识库共用此目录；知识库保存在其中的 knowledge 文件夹。切换目录时，原资料留在原处。</p>
        </section>
        <section className="settings-section">
          <h3 className="settings-label">主题</h3>
          <div className="seg" role="group" aria-label="主题">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={settings.theme === t.id}
                className={`seg-btn${settings.theme === t.id ? ' is-active' : ''}`}
                onClick={() => onChange({ theme: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <details className="settings-section settings-disclosure">
          <summary><span>窗口材质</span><span className="settings-summary-value">{GLASS_MODES.find(mode => mode.id === effectiveGlassMode)?.label}</span></summary>
          <div className="seg" role="group" aria-label="窗口材质">
            {GLASS_MODES.filter(mode => mode.id !== 'native' || isMac).map((m) => {
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={effectiveGlassMode === m.id}
                  className={`seg-btn${effectiveGlassMode === m.id ? ' is-active' : ''}`}
                  onClick={() =>
                    m.id === 'off'
                      ? onChange({ glass: false })
                      : onChange({ glass: true, glassMode: m.id })
                  }
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <p className="settings-hint">调整浮层的透明感，不影响正文阅读。</p>

          <div className={`settings-sliders${effectiveGlassMode === 'off' ? ' is-disabled' : ''}`}>
            <div className="slider-row">
              <span className="slider-name">通透度</span>
              <input
                type="range"
                aria-label="通透度"
                min={0}
                max={100}
                value={settings.glassClarity}
                disabled={effectiveGlassMode === 'off'}
                onChange={(e) => onChange({ glassClarity: Number(e.target.value) })}
              />
              <span className="slider-val">{settings.glassClarity}</span>
            </div>
            <div className="slider-row">
              <span className="slider-name">模糊</span>
              <input
                type="range"
                aria-label="模糊"
                min={0}
                max={100}
                value={settings.glassBlur}
                disabled={effectiveGlassMode === 'off'}
                onChange={(e) => onChange({ glassBlur: Number(e.target.value) })}
              />
              <span className="slider-val">{settings.glassBlur}</span>
            </div>
          </div>
        </details>

        <section className="settings-section">
          <h3 className="settings-label">连线样式</h3>
          <div className="seg" role="group" aria-label="连线样式">
            {EDGE_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={(settings.edgeStyle ?? 'curved') === s.id}
                className={`seg-btn${(settings.edgeStyle ?? 'curved') === s.id ? ' is-active' : ''}`}
                onClick={() => onChange({ edgeStyle: s.id })}
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <span className="settings-label">自动识别公式</span>
            <button
              type="button"
              className={`switch${settings.guessMath ? ' is-on' : ''}`}
              role="switch"
              aria-label="自动识别公式"
              aria-checked={settings.guessMath}
              onClick={() => onChange({ guessMath: !settings.guessMath })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="settings-hint">
            识别正文中没有标记的数学公式。
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <span className="settings-label">动画</span>
            <button
              type="button"
              className={`switch${settings.motion ? ' is-on' : ''}`}
              role="switch"
              aria-label="动画"
              aria-checked={settings.motion}
              onClick={() => onChange({ motion: !settings.motion })}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </section>
        <SyncSettings key={storageRoot ?? ''} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
