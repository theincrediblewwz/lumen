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
  type ReaderMode,
} from '../reader/readerPrefs';

const COLUMN_GAP = 48; // 双页两栏之间的间隙（页内留白，非页间缝隙）

/**
 * 阅读器视图（M4-1/5/6/8 + 阅读体验增强）。既用于应用内浮层，也用于独立窗口。
 * - 主题跟随软件主体（不再单独选主题；ADR-027）
 * - 顶栏：标题、字号 A−/A+、阅读模式（连续滚动 / 双页）、全屏、关闭
 * - 左侧：树形目录（TOC），点击锚点跳转 + 高亮
 * - 主体：渲染后的 Markdown + KaTeX 分批排版
 * - 双页：CSS 多栏横向铺排，页间无缝；每页左下角标注页码
 * - 记忆：字号/模式（全局）、阅读进度（按 docKey）
 */
export function ReaderView({
  title,
  markdown,
  docKey,
  onClose,
  standalone = false,
  guessMath = false,
  platform = '',
}: {
  title: string;
  markdown: string;
  docKey: string;
  onClose?: () => void;
  standalone?: boolean;
  guessMath?: boolean;
  /** 独立窗口时用于自绘标题栏（'macos' 留红绿灯位；其它画 Win 三键） */
  platform?: string;
}) {
  const isMac = platform === 'macos';
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const [activeSlug, setActiveSlug] = useState<string>('');
  const [pageInfo, setPageInfo] = useState<{ pages: number; current: number; step: number }>({
    pages: 1,
    current: 1,
    step: 1,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

  const paged = prefs.mode === 'paged';

  const { html, toc } = useMemo(
    () => renderMarkdown(markdown, undefined, { guessMath }),
    [markdown, guessMath],
  );

  useEffect(() => savePrefs(prefs), [prefs]);

  /** 双页模式：按视口算每栏宽度，使正好两栏并排；返回每“页”滚动步长。 */
  const layoutPaged = useCallback(() => {
    const body = bodyRef.current;
    const flow = flowRef.current;
    if (!body || !flow) return;
    if (!paged) {
      setPageInfo({ pages: 1, current: 1, step: 1 });
      return;
    }
    const avail = body.clientWidth;
    // 两栏并排：每栏宽 = (可用宽 - 一个间隙) / 2
    const colW = Math.max(280, Math.floor((avail - COLUMN_GAP) / 2));
    flow.style.columnWidth = `${colW}px`;
    flow.style.columnGap = `${COLUMN_GAP}px`;
    const step = colW + COLUMN_GAP; // 一页的横向步长
    // 布局后测量总宽
    requestAnimationFrame(() => {
      const total = flow.scrollWidth;
      const pages = Math.max(1, Math.round(total / step));
      setPageInfo({
        pages,
        step,
        current: Math.min(pages, Math.floor(body.scrollLeft / step) + 1),
      });
    });
  }, [paged]);

  // 上屏：分批排版公式 → 布局分页 → 恢复进度
  useEffect(() => {
    const el = bodyRef.current;
    const flow = flowRef.current;
    if (!el || !flow) return;
    restoredRef.current = false;
    const handle = typesetMath(flow);
    handle.done.then(() => {
      layoutPaged();
      if (restoredRef.current) return;
      restoredRef.current = true;
      const ratio = getProgress(docKey);
      requestAnimationFrame(() => {
        if (paged) {
          el.scrollLeft = ratio * (el.scrollWidth - el.clientWidth);
        } else if (ratio > 0) {
          el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
        }
      });
    });
    return () => handle.cancel();
  }, [html, docKey, paged, layoutPaged]);

  // 视口尺寸变化重新分页
  useEffect(() => {
    if (!paged) return;
    const onResize = () => layoutPaged();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paged, layoutPaged]);

  // 全屏状态跟随
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (paged) {
      const denom = el.scrollWidth - el.clientWidth;
      if (denom > 0) setProgress(docKey, el.scrollLeft / denom);
      setScrollLeft(el.scrollLeft);
      setPageInfo((p) => ({ ...p, current: Math.min(p.pages, Math.floor(el.scrollLeft / p.step) + 1) }));
      return;
    }
    const denom = el.scrollHeight - el.clientHeight;
    if (denom > 0) setProgress(docKey, el.scrollTop / denom);
    const heads = flowRef.current?.querySelectorAll<HTMLElement>('.md-heading');
    if (heads) {
      let cur = '';
      for (const h of Array.from(heads)) {
        if (h.offsetTop - el.scrollTop <= 80) cur = h.id;
        else break;
      }
      if (cur) setActiveSlug(cur);
    }
  }, [docKey, paged]);

  // 双页模式：竖直滚轮 → 横向翻页滚动
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!paged) return;
      const el = bodyRef.current;
      if (!el) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
      }
    },
    [paged],
  );

  const changeFont = (delta: number) =>
    setPrefs((p) => ({ ...p, fontScale: clampFont(p.fontScale + delta) }));

  const setMode = (mode: ReaderMode) => setPrefs((p) => ({ ...p, mode }));

  const jump = (slug: string) => {
    const el = bodyRef.current;
    const flow = flowRef.current;
    if (!el || !flow) return;
    if (paged) {
      const target = flow.querySelector<HTMLElement>(`#${cssEscape(slug)}`);
      if (target) {
        // 目标所在页 = 其 offsetLeft 落在哪一页
        const page = Math.floor(target.offsetLeft / pageInfo.step);
        el.scrollTo({ left: page * pageInfo.step, behavior: 'smooth' });
      }
    } else {
      scrollToSlug(flow, slug);
    }
    setActiveSlug(slug);
  };

  const toggleFullscreen = () => {
    const node = rootRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void node.requestFullscreen?.();
    }
  };

  const flipPage = (dir: 1 | -1) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * pageInfo.step * 2, behavior: 'smooth' });
  };

  // 独立窗口的窗口控制（无系统装饰，自绘）
  const winCtl = useCallback(async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      if (action === 'minimize') await w.minimize();
      else if (action === 'maximize') await w.toggleMaximize();
      else await w.close();
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  }, []);

  const showWinControls = standalone && !isMac;

  return (
    <div
      ref={rootRef}
      className={`reader${standalone ? ' is-standalone' : ''}${paged ? ' is-paged' : ''}${
        isFullscreen ? ' is-fullscreen' : ''
      }`}
      style={{ ['--reader-font-scale' as string]: String(prefs.fontScale / 100) }}
    >
      <header
        className={`reader-bar${standalone ? ' is-standalone-bar' : ''}${isMac && standalone ? ' is-mac' : ''}`}
        {...(standalone ? { 'data-tauri-drag-region': true } : {})}
      >
        <h1 className="reader-title" title={title} {...(standalone ? { 'data-tauri-drag-region': true } : {})}>{title}</h1>
        <div className="reader-tools">
          <div className="reader-seg">
            <button
              type="button"
              className={`reader-btn${!paged ? ' is-active' : ''}`}
              title="连续滚动"
              onClick={() => setMode('continuous')}
            >
              连续
            </button>
            <button
              type="button"
              className={`reader-btn${paged ? ' is-active' : ''}`}
              title="双页阅读"
              onClick={() => setMode('paged')}
            >
              双页
            </button>
          </div>
          <div className="reader-seg">
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
          <button
            type="button"
            className="reader-btn reader-icon"
            title={isFullscreen ? '退出全屏' : '全屏阅读'}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {onClose && (
            <button type="button" className="reader-btn reader-icon reader-close" title="关闭 (Esc)" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {showWinControls && (
            <div className="reader-wincontrols">
              <button type="button" className="win-btn" title="最小化" aria-label="最小化" onClick={() => winCtl('minimize')}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </button>
              <button type="button" className="win-btn" title="最大化" aria-label="最大化" onClick={() => winCtl('maximize')}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1.3" y="1.3" width="7.4" height="7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </button>
              <button type="button" className="win-btn win-close" title="关闭" aria-label="关闭" onClick={() => winCtl('close')}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="reader-main">
        {toc.length > 0 && !isFullscreen && (
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

        <div className="reader-stage">
          <div
            ref={bodyRef}
            className="reader-body"
            onScroll={onScroll}
            onWheel={onWheel}
          >
            <div
              ref={flowRef}
              className="reader-pageflow markdown-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>

          {paged && (
            <>
              {/* 每页左下角页码 */}
              <div className="reader-pagenums" aria-hidden="true">
                {Array.from({ length: pageInfo.pages }, (_, i) => (
                  <span
                    key={i}
                    className="reader-pagenum"
                    style={{ left: i * pageInfo.step + 10 - scrollLeft }}
                  >
                    {i + 1}
                  </span>
                ))}
              </div>
              {/* 翻页按钮 */}
              <button
                type="button"
                className="reader-flip reader-flip-prev"
                title="上一页"
                disabled={pageInfo.current <= 1}
                onClick={() => flipPage(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="reader-flip reader-flip-next"
                title="下一页"
                disabled={pageInfo.current >= pageInfo.pages}
                onClick={() => flipPage(1)}
              >
                ›
              </button>
              <div className="reader-pagebar">
                第 {pageInfo.current}–{Math.min(pageInfo.pages, pageInfo.current + 1)} 页 · 共 {pageInfo.pages} 页
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => `\\${c}`);
}

