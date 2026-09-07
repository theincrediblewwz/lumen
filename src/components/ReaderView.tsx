import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { renderMarkdown, type TocItem } from '../reader/engine';
import { typesetMath, scrollToSlug } from '../reader/reader';
import {
  loadPrefs,
  savePrefs,
  clampFont,
  getProgress,
  setProgress,
  FONT_MIN,
  FONT_MAX,
  FONT_STEP,
  type ReaderPrefs,
  type ReaderTheme,
} from '../reader/readerPrefs';

const THEMES: { id: ReaderTheme; label: string }[] = [
  { id: 'light', label: '浅' },
  { id: 'paper', label: '纸' },
  { id: 'dark', label: '暗' },
];

/**
 * 阅读器视图（M4-1/5/6/8）。既用于应用内浮层，也用于独立窗口。
 * - 顶栏：标题、字号 A−/A+、主题切换、（可选）关闭
 * - 左侧：树形目录（TOC），点击锚点跳转 + 高亮
 * - 主体：渲染后的 Markdown + KaTeX 分批排版
 * - 记忆：字号/主题（全局）、阅读进度（按 docKey）
 */
export function ReaderView({
  title,
  markdown,
  docKey,
  onClose,
  standalone = false,
}: {
  title: string;
  markdown: string;
  /** 用于阅读进度记忆的稳定 key（一般是 project/board/path） */
  docKey: string;
  onClose?: () => void;
  /** 独立窗口模式：占满视口、不显示浮层阴影 */
  standalone?: boolean;
}) {
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const [activeSlug, setActiveSlug] = useState<string>('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

  const { html, toc } = useMemo(() => renderMarkdown(markdown), [markdown]);

  // 持久化偏好
  useEffect(() => savePrefs(prefs), [prefs]);

  // 上屏后：分批排版公式 + 恢复上次阅读进度
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    restoredRef.current = false;
    const handle = typesetMath(el);
    handle.done.then(() => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      const ratio = getProgress(docKey);
      if (ratio > 0) {
        el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
      }
    });
    return () => handle.cancel();
  }, [html, docKey]);

  // 滚动：记忆进度 + 高亮当前章节
  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const denom = el.scrollHeight - el.clientHeight;
    if (denom > 0) setProgress(docKey, el.scrollTop / denom);
    // 当前可视最靠上的标题
    const heads = el.querySelectorAll<HTMLElement>('.md-heading');
    let cur = '';
    for (const h of Array.from(heads)) {
      if (h.offsetTop - el.scrollTop <= 80) cur = h.id;
      else break;
    }
    if (cur) setActiveSlug(cur);
  }, [docKey]);

  const changeFont = (delta: number) =>
    setPrefs((p) => ({ ...p, fontScale: clampFont(p.fontScale + delta) }));

  const jump = (slug: string) => {
    const el = bodyRef.current;
    if (el) {
      scrollToSlug(el, slug);
      setActiveSlug(slug);
    }
  };

  return (
    <div
      className={`reader${standalone ? ' is-standalone' : ''}`}
      data-reader-theme={prefs.theme}
      style={{ ['--reader-font-scale' as string]: String(prefs.fontScale / 100) }}
    >
      <header className="reader-bar">
        <h1 className="reader-title" title={title}>{title}</h1>
        <div className="reader-tools">
          <div className="reader-font">
            <button
              type="button"
              className="reader-btn"
              title="减小字号"
              disabled={prefs.fontScale <= FONT_MIN}
              onClick={() => changeFont(-FONT_STEP)}
            >
              A−
            </button>
            <span className="reader-font-val">{prefs.fontScale}%</span>
            <button
              type="button"
              className="reader-btn"
              title="增大字号"
              disabled={prefs.fontScale >= FONT_MAX}
              onClick={() => changeFont(FONT_STEP)}
            >
              A+
            </button>
          </div>
          <div className="reader-themes">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`reader-btn${prefs.theme === t.id ? ' is-active' : ''}`}
                title={`${t.label}色主题`}
                onClick={() => setPrefs((p) => ({ ...p, theme: t.id }))}
              >
                {t.label}
              </button>
            ))}
          </div>
          {onClose && (
            <button type="button" className="reader-btn reader-close" title="关闭 (Esc)" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <div className="reader-main">
        {toc.length > 0 && (
          <nav className="reader-toc" aria-label="目录">
            <div className="reader-toc-head">目录</div>
            <ul className="reader-toc-list">
              {toc.map((item: TocItem, i) => (
                <li
                  key={`${item.slug}-${i}`}
                  className={`reader-toc-item lvl-${item.level}${activeSlug === item.slug ? ' is-active' : ''}`}
                >
                  <button type="button" onClick={() => jump(item.slug)} title={item.text}>
                    {item.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article
          ref={bodyRef}
          className="reader-body markdown-body"
          onScroll={onScroll}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
