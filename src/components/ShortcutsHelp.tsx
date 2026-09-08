import { useEffect, useMemo } from 'react';
import { SHORTCUTS, formatShortcut, isMac, type ShortcutGroup } from '../canvas/shortcuts';

/**
 * 快捷键帮助（M6-9）：Shift+/（即 ?）打开，列出全部快捷键，按组分类，平台感知显示 ⌘/Ctrl。
 * 复用 .gs-overlay 遮罩样式。
 */

const GROUP_ORDER: ShortcutGroup[] = ['全局', '视图', '画布', '节点'];

export function ShortcutsHelp({
  open,
  platform,
  onClose,
}: {
  open: boolean;
  /** 传入 App 的 platform（'darwin'/'win32'/…）用于 ⌘/Ctrl 显示；缺省时自动探测 */
  platform?: string;
  onClose: () => void;
}) {
  const mac = useMemo(
    () => (platform ? /darwin|mac/i.test(platform) : isMac()),
    [platform],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: SHORTCUTS.filter((s) => s.group === g),
    })).filter((x) => x.items.length > 0);
  }, []);

  if (!open) return null;

  return (
    <div className="gs-overlay" onClick={onClose}>
      <div
        className="gs-panel sc-panel glass-surface"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键帮助"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-head">
          <span className="sc-title">键盘快捷键</span>
          <button type="button" className="snap-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="sc-body">
          {grouped.map(({ group, items }) => (
            <section key={group} className="sc-group" aria-label={group}>
              <h3 className="sc-group-title">{group}</h3>
              <ul className="sc-list">
                {items.map((s) => (
                  <li key={s.id} className="sc-row">
                    <span className="sc-label">{s.label}</span>
                    <span className="sc-keys">
                      {s.combos.map((c, i) => (
                        <span key={c}>
                          {i > 0 && <span className="sc-or">或</span>}
                          <kbd className="sc-kbd">{formatShortcut({ ...s, combos: [c] }, { mac })}</kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
