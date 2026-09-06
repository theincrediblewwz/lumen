import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Settings, ThemeName } from '../settings';

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'paper', label: '纸感' },
  { id: 'dark', label: '深色' },
];

/**
 * 设置面板：主题、液态玻璃开关与通透度/模糊、动画开关。
 * 以玻璃卡片形式居中浮出；点击遮罩或 Esc 关闭。
 */
export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        className="settings-card glass-surface"
        role="dialog"
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

        <section className="settings-section">
          <label className="settings-label">主题</label>
          <div className="seg">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`seg-btn${settings.theme === t.id ? ' is-active' : ''}`}
                onClick={() => onChange({ theme: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <label className="settings-label">液态玻璃</label>
            <button
              type="button"
              className={`switch${settings.glass ? ' is-on' : ''}`}
              role="switch"
              aria-checked={settings.glass}
              onClick={() => onChange({ glass: !settings.glass })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="settings-hint">
            为侧栏、菜单、卡片启用毛玻璃质感（模糊 + 提饱和 + 亮边高光）。
          </p>

          <div className={`settings-sliders${settings.glass ? '' : ' is-disabled'}`}>
            <div className="slider-row">
              <span className="slider-name">通透度</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.glassClarity}
                disabled={!settings.glass}
                onChange={(e) => onChange({ glassClarity: Number(e.target.value) })}
              />
              <span className="slider-val">{settings.glassClarity}</span>
            </div>
            <div className="slider-row">
              <span className="slider-name">模糊</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.glassBlur}
                disabled={!settings.glass}
                onChange={(e) => onChange({ glassBlur: Number(e.target.value) })}
              />
              <span className="slider-val">{settings.glassBlur}</span>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <label className="settings-label">动画特效</label>
            <button
              type="button"
              className={`switch${settings.motion ? ' is-on' : ''}`}
              role="switch"
              aria-checked={settings.motion}
              onClick={() => onChange({ motion: !settings.motion })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="settings-hint">关闭后所有过渡与位移动画立即停用（也尊重系统「减少动态效果」）。</p>
        </section>
      </div>
    </div>,
    document.body,
  );
}
