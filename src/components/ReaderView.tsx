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

const COLUMN_GAP = 56; // 双页两栏（左页/右页）之间的中缝

/**
 * 阅读器视图（M4-1/5/6/8 + 阅读体验增强）。既用于应用内浮层，也用于独立窗口。
 * - 主题跟随软件主体（不再单独选主题；ADR-027）
 * - 顶栏：标题、字号 A−/A+、阅读模式（连续滚动 / 双页）、全屏、关闭
 * - 左侧：树形目录（TOC，含公式渲染），点击锚点跳转 + 高亮
 * - 主体：渲染后的 Markdown + KaTeX 分批排版
 * - 双页：像 PDF 阅读器——左右两页铺满整屏，滚轮/按钮向「下一跨页」翻，
 *   内容用 CSS 多栏按视口高度切列，两列为一个跨页，用 transform 平移切换，
 *   不出现横向滚动条（不会「往后面滑」）。
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
  // 双页：spread=当前跨页(0-based)，spreads=总跨页数，step=单列步长(列宽+缝)
  const [spread, setSpread] = useState(0);
  const [spreads, setSpreads] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef(1);
  const restoredRef = useRef(false);
  const wheelAccum = useRef(0);
  const wheelLock = useRef(false);

  const paged = prefs.mode === 'paged';

  const { html, toc } = useMemo(
    () => renderMarkdown(markdown, undefined, { guessMath }),
    [markdown, guessMath],
  );

  useEffect(() => savePrefs(prefs), [prefs]);

  /** 双页：按视口算列宽（两列铺满），切列高=视口高；返回列数并算跨页数。 */
  const layoutPaged = useCallback(() => {
    const body = bodyRef.current;
    const flow = flowRef.current;
    if (!body || !flow) return;
    if (!paged) {
      flow.style.removeProperty('column-width');
      flow.style.removeProperty('column-gap');
      flow.style.removeProperty('height');
      flow.style.removeProperty('transform');
      setSpreads(1);
      return;
    }
    const avail = body.clientWidth;
    const colW = Math.max(240, Math.floor((avail - COLUMN_GAP) / 2));
    flow.style.columnWidth = `${colW}px`;
    flow.style.columnGap = `${COLUMN_GAP}px`;
    flow.style.height = `${body.clientHeight}px`;
    const step = colW + COLUMN_GAP;
    stepRef.current = step;
    requestAnimationFrame(() => {
      const total = flow.scrollWidth;
      const cols = Math.max(1, Math.round(total / step));
      const sp = Math.max(1, Math.ceil(cols / 2)); // 两列 = 一个跨页
      setSpreads(sp);
      setSpread((s) => Math.min(s, sp - 1));
    });
  }, [paged]);

  // 双页：把当前跨页平移到视口（transform，两列一屏）
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    if (paged) {
      flow.style.transform = `translateX(-${spread * 2 * stepRef.current}px)`;
    } else {
      flow.style.transform = '';
    }
  }, [spread, paged, spreads]);

  // 上屏：正文分批排版 → 布局分页 → 恢复进度；同时排版 TOC 里的公式
  useEffect(() => {
    const el = bodyRef.current;
    const flow = flowRef.current;
    if (!el || !flow) return;
    restoredRef.current = false;
    const handle = typesetMath(flow);
    const tocHandle = tocRef.current ? typesetMath(tocRef.current, 60) : null;
    handle.done.then(() => {
      layoutPaged();
      if (restoredRef.current) return;
      restoredRef.current = true;
      const ratio = getProgress(docKey);
      requestAnimationFrame(() => {
        if (paged) {
          // 进度 → 跨页
          const flow2 = flowRef.current;
          if (flow2) {
            const cols = Math.max(1, Math.round(flow2.scrollWidth / stepRef.current));
            const sp = Math.max(1, Math.ceil(cols / 2));
            setSpread(Math.min(sp - 1, Math.round(ratio * (sp - 1))));
          }
        } else if (ratio > 0) {
          el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
        }
      });
    });
    return () => {
      handle.cancel();
      tocHandle?.cancel();
    };
  }, [html, docKey, paged, layoutPaged]);

  // 视口尺寸变化重新分页
  useEffect(() => {
    if (!paged) return;
    const onResize = () => layoutPaged();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paged, layoutPaged]);

  // 双页进度保存
  useEffect(() => {
    if (paged && spreads > 1) setProgress(docKey, spread / (spreads - 1));
  }, [spread, spreads, paged, docKey]);

  // 全屏状态跟随
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const flipSpread = useCallback(
    (dir: 1 | -1) => setSpread((s) => Math.max(0, Math.min(spreads - 1, s + dir))),
    [spreads],
  );

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el || paged) return;
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

  // 双页：滚轮（竖或横）→ 向「下一/上一跨页」翻。带阈值与锁，翻页干脆不连跳。
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!paged) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (wheelLock.current) return;
      wheelAccum.current += delta;
      const THRESHOLD = 40;
      if (wheelAccum.current > THRESHOLD) {
        flipSpread(1);
        wheelAccum.current = 0;
        wheelLock.current = true;
        setTimeout(() => (wheelLock.current = false), 380);
      } else if (wheelAccum.current < -THRESHOLD) {
        flipSpread(-1);
        wheelAccum.current = 0;
        wheelLock.current = true;
        setTimeout(() => (wheelLock.current = false), 380);
      }
    },
    [paged, flipSpread],
  );

  // 键盘翻页（双页）
  useEffect(() => {
    if (!paged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        flipSpread(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        flipSpread(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paged, flipSpread]);

  const changeFont = (delta: number) =>
    setPrefs((p) => ({ ...p, fontScale: clampFont(p.fontScale + delta) }));

  const setMode = (mode: ReaderMode) => {
    setPrefs((p) => ({ ...p, mode }));
    setSpread(0);
  };

  const jump = (slug: string) => {
    const el = bodyRef.current;
    const flow = flowRef.current;
    if (!el || !flow) return;
    if (paged) {
      const target = flow.querySelector<HTMLElement>(`#${cssEscape(slug)}`);
      if (target) {
        const col = Math.floor(target.offsetLeft / stepRef.current);
        setSpread(Math.min(spreads - 1, Math.floor(col / 2)));
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
  const leftPage = spread * 2 + 1;
  const rightPage = Math.min(spreads * 2, leftPage + 1);

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
          <nav className="reader-toc" aria-label="目录" ref={tocRef}>
            <div className="reader-toc-head">目录</div>
            <ul className="reader-toc-list">
              {toc.map((item: TocItem, i) => (
                <li
                  key={`${item.slug}-${i}`}
                  className={`reader-toc-item lvl-${item.level}${activeSlug === item.slug ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => jump(item.slug)}
                    title={item.text}
                    dangerouslySetInnerHTML={{ __html: item.html }}
                  />
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
              {/* 中缝分隔线（左右两页之间） */}
              <div className="reader-gutter" aria-hidden="true" />
              {/* 翻页按钮 */}
              <button
                type="button"
                className="reader-flip reader-flip-prev"
                title="上一跨页"
                disabled={spread <= 0}
                onClick={() => flipSpread(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="reader-flip reader-flip-next"
                title="下一跨页"
                disabled={spread >= spreads - 1}
                onClick={() => flipSpread(1)}
              >
                ›
              </button>
              {/* 左下角页码 */}
              <div className="reader-pagenum reader-pagenum-left" aria-hidden="true">{leftPage}</div>
              <div className="reader-pagenum reader-pagenum-right" aria-hidden="true">{rightPage}</div>
              <div className="reader-pagebar">
                第 {leftPage}{rightPage > leftPage ? `–${rightPage}` : ''} 页 · 共 {spreads * 2} 页
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
