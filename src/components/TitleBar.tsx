import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

/**
 * 自定义标题栏（native_mac 策略）
 * - macOS：window.titleBarStyle=Overlay 保留系统红绿灯并让内容延伸到标题栏；
 *   本栏只在左侧留出红绿灯安全区，不自绘窗口按钮。
 * - Windows：window.decorations=false 隐藏系统栏，本栏在右侧自绘 最小化/最大化/关闭。
 * 整条标题栏为拖拽区（data-tauri-drag-region），交互元素标记为 no-drag。
 */
export function TitleBar({
  platform,
  brand,
  onMenu,
}: {
  platform: string; // 'macos' | 'windows' | 'linux' | ...
  brand: string;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const isMac = platform === 'macos';
  const showWinControls = !isMac; // Windows / Linux 自绘按钮
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((f) => (un = f))
      .catch(() => {});
    return () => un?.();
  }, [win]);

  return (
    <div
      className={`titlebar${isMac ? ' is-mac' : ''}`}
      data-tauri-drag-region
    >
      <span className="titlebar-brand" data-tauri-drag-region>
        {brand}
      </span>

      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn titlebar-menu"
          title="菜单"
          aria-label="菜单"
          onClick={onMenu}
        >
          {/* 汉堡菜单图标（内联 SVG，避免外链） */}
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>

        {showWinControls && (
          <div className="win-controls">
            <button
              type="button"
              className="win-btn"
              title="最小化"
              aria-label="最小化"
              onClick={() => win.minimize()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn"
              title={maximized ? '还原' : '最大化'}
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => win.toggleMaximize()}
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.2" y="2.6" width="6.2" height="6.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M3.2 2.6V1.2h5.6v5.6H7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.3" y="1.3" width="7.4" height="7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="win-btn win-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => win.close()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
