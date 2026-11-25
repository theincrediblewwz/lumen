import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Menu, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import icon from '../../app-icon.png';

/**
 * 自定义标题栏（native_mac 策略）
 * - macOS：window.titleBarStyle=Overlay 保留系统红绿灯并让内容延伸到标题栏；
 *   本栏只在左侧留出红绿灯安全区，不自绘窗口按钮。
 * - Windows：window.decorations=false 隐藏系统栏，本栏在右侧自绘 最小化/最大化/关闭。
 * 从标题栏空白处或静态文字拖动窗口，按钮和链接保留原有交互。
 */
export function TitleBar({
  platform,
  brand,
  onMenu,
  menuOpen,
  onHome,
  onSettings,
  onFullscreen,
  fadeToCanvas = false,
  fullscreen,
  onToggleIndex,
  indexCollapsed,
  path,
  boardAction,
  filter,
}: {
  platform: string; // 'macos' | 'windows' | 'linux' | ...
  brand: string;
  onMenu: (e: React.MouseEvent) => void;
  menuOpen: boolean;
  onHome?: () => void;
  onSettings: () => void;
  onFullscreen: () => void;
  fadeToCanvas?: boolean;
  fullscreen: boolean;
  onToggleIndex?: () => void;
  indexCollapsed?: boolean;
  path?: ReactNode;
  boardAction?: ReactNode;
  filter?: ReactNode;
}) {
  const isMac = platform === 'macos';
  const showWinControls = Boolean(platform) && !isMac; // 平台确认后再显示自绘按钮
  const win = useMemo(getCurrentWindow, []);
  const [maximized, setMaximized] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bar.current) bar.current.inert = fullscreen;
  }, [fullscreen]);

  useEffect(() => {
    if (!showWinControls) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const refresh = () => void win.isMaximized().then(active => { if (!disposed) setMaximized(active); }).catch(() => {});
    refresh();
    void win.onResized(refresh).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, [showWinControls, win]);

  return (
    <div
      ref={bar}
      className={`titlebar${isMac ? ' is-mac' : ''}${!platform ? ' is-platform-pending' : ''}${fadeToCanvas ? ' fades-to-canvas' : ''}`}
      aria-hidden={fullscreen || undefined}
      data-tauri-drag-region="deep"
    >
      {onHome ? (
        <button type="button" className="titlebar-btn titlebar-logo" aria-label="返回项目首页" onClick={onHome}>
          <img src={icon} width="26" height="26" alt="" /><span>{brand}</span>
        </button>
      ) : (
        <span className="titlebar-logo" data-tauri-drag-region>
          <img src={icon} width="26" height="26" alt="" data-tauri-drag-region /><span data-tauri-drag-region>{brand}</span>
        </span>
      )}
      {path}
      <div className="titlebar-actions">
        {boardAction}
        <button type="button" className="titlebar-btn titlebar-menu titlebar-fullscreen"
          aria-label="进入全屏" title="进入全屏 (F11)" onClick={onFullscreen}>
          <Maximize2 size={17} aria-hidden="true" />
        </button>
        {filter}
        {onToggleIndex && (
          <button type="button" className="titlebar-btn titlebar-menu"
            aria-label={indexCollapsed ? '展开知识索引' : '收起知识索引'}
            title={indexCollapsed ? '展开知识索引' : '收起知识索引'}
            aria-pressed={!indexCollapsed} onClick={onToggleIndex}>
            {indexCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        )}
        <button
          type="button"
          className="titlebar-btn titlebar-menu"
          title="设置"
          aria-label="设置"
          onClick={onSettings}
        >
          <Settings size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-menu"
          title="菜单"
          aria-label="菜单"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <Menu size={19} aria-hidden="true" />
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
