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

// 双页排版几何
const GAP = 56; // 左右两页（列）之间的中缝
const PAGE_PAD_X = 48; // 每页左右内边距
const PAGE_PAD_Y = 44; // 每页上下内边距
const SHEET_MARGIN = 22; // 相邻纸页之间的竖直间距

/**
 * 阅读器视图（M4 + 阅读体验增强）。既用于应用内浮层，也用于独立窗口。
 * - 主题跟随软件主体（ADR-027）
 * - 顶栏：标题、字号、阅读模式（连续 / 双页）、全屏、关闭、（独立窗）窗口控制
 * - 左侧：目录（TOC，含公式渲染）
 * - 连续模式：单列，自然竖向滚动
 * - 双页模式（ADR-030）：像 PDF——竖向连续滚动的一张张“纸”，每张纸由中缝分成
 *   左右两栏，正文按「左栏从上到下填满 → 右栏接着往下 → 下一张纸」的顺序排版；
 *   向下滚动即翻到后面的纸。用 JS 按列高把顶层块分配到左右栏、再堆叠成纸页。
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
  const [pageInfo, setPageInfo] = useState<{ pages: number; current: number }>({ pages: 1, current: 1 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null); // 连续模式正文 / 双页测量源
  const pagesRef = useRef<HTMLDivElement>(null); // 双页：堆叠的纸页
  const tocRef = useRef<HTMLDivElement>(null);
  const sheetStepRef = useRef(1); // 一张纸的竖直步长（纸高 + 间距）
  const restoredRef = useRef(false);

  const paged = prefs.mode === 'paged';

  const { html, toc } = useMemo(
    () => renderMarkdown(markdown, undefined, { guessMath }),
    [markdown, guessMath],
  );

  useEffect(() => savePrefs(prefs), [prefs]);

  /**
   * 双页分页：把 contentRef 里的顶层块，按“列高”依次塞进一列列里，
   * 每两列拼成一张纸（左栏 + 中缝 + 右栏），纸页竖直堆叠。
   */
  const paginate = useCallback(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!body || !content || !pages) return;

    const bodyW = body.clientWidth;
    const colW = Math.max(220, Math.floor((bodyW - GAP - 2 * PAGE_PAD_X) / 2));
    const colH = Math.max(320, body.clientHeight - 2 * PAGE_PAD_Y - SHEET_MARGIN);

    // 先按列宽测量各块高度（保证换行与实际列一致）
    content.style.width = `${colW}px`;
    const blocks = Array.from(content.children) as HTMLElement[];
    const measured = blocks.map((b) => ({ el: b, h: b.offsetHeight }));

    // 贪心分列
    const columns: HTMLElement[][] = [[]];
    let curH = 0;
    for (const { el, h } of measured) {
      if (curH > 0 && curH + h > colH) {
        columns.push([]);
        curH = 0;
      }
      columns[columns.length - 1].push(el);
      curH += h;
    }

    // 每两列拼一张纸
    pages.innerHTML = '';
    const sheetH = colH + 2 * PAGE_PAD_Y;
    sheetStepRef.current = sheetH + SHEET_MARGIN;
    for (let i = 0; i < columns.length; i += 2) {
      const sheet = document.createElement('div');
      sheet.className = 'reader-sheet';
      sheet.style.height = `${sheetH}px`;
      sheet.style.padding = `${PAGE_PAD_Y}px ${PAGE_PAD_X}px`;
      sheet.style.columnGap = `${GAP}px`;

      const left = document.createElement('div');
      left.className = 'reader-sheet-col';
      left.style.width = `${colW}px`;
      columns[i]?.forEach((el) => left.appendChild(el));

      const gutter = document.createElement('div');
      gutter.className = 'reader-sheet-gutter';

      const right = document.createElement('div');
      right.className = 'reader-sheet-col';
      right.style.width = `${colW}px`;
      columns[i + 1]?.forEach((el) => right.appendChild(el));

      // 页码（左右各一）
      const pnL = document.createElement('span');
      pnL.className = 'reader-sheet-pn reader-sheet-pn-left';
      pnL.textContent = String(i + 1);
      const pnR = document.createElement('span');
      pnR.className = 'reader-sheet-pn reader-sheet-pn-right';
      pnR.textContent = String(i + 2);

      sheet.appendChild(left);
      sheet.appendChild(gutter);
      sheet.appendChild(right);
      sheet.appendChild(pnL);
      if (columns[i + 1]) sheet.appendChild(pnR);
      pages.appendChild(sheet);
    }
    content.style.width = '';
    setPageInfo({ pages: columns.length, current: 1 });
  }, []);

  // 上屏：把 html 放入测量源 → 排版公式（正文 + 目录）→（双页则分页）→ 恢复进度
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) return;
    restoredRef.current = false;
    content.innerHTML = html;
    if (pagesRef.current) pagesRef.current.innerHTML = '';

    const handle = typesetMath(content);
    const tocHandle = tocRef.current ? typesetMath(tocRef.current, 60) : null;
    let cancelled = false;

    handle.done.then(() => {
      if (cancelled) return;
      if (paged) paginate();
      if (restoredRef.current) return;
      restoredRef.current = true;
      const ratio = getProgress(docKey);
      requestAnimationFrame(() => {
        const el = bodyRef.current;
        if (!el) return;
        if (ratio > 0) el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
      });
    });

    return () => {
      cancelled = true;
      handle.cancel();
      tocHandle?.cancel();
    };
  }, [html, docKey, paged, paginate]);

  // 视口/字号变化：双页重新分页（字号通过 --reader-font-scale 影响块高）
  useEffect(() => {
    if (!paged) return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 重新测量：把纸页里的块搬回测量源再分页
        const content = contentRef.current;
        const pages = pagesRef.current;
        if (content && pages) {
          const cols = pages.querySelectorAll<HTMLElement>('.reader-sheet-col');
          cols.forEach((c) => {
            while (c.firstChild) content.appendChild(c.firstChild);
          });
          paginate();
        }
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [paged, paginate]);

  // 字号变化时（双页）重新分页
  useEffect(() => {
    if (!paged) return;
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!content || !pages) return;
    const cols = pages.querySelectorAll<HTMLElement>('.reader-sheet-col');
    if (cols.length === 0) return; // 尚未分页（首个 effect 会处理）
    cols.forEach((c) => {
      while (c.firstChild) content.appendChild(c.firstChild);
    });
    paginate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.fontScale]);

  // 全屏状态跟随
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const denom = el.scrollHeight - el.clientHeight;
    if (denom > 0) setProgress(docKey, el.scrollTop / denom);
    if (paged) {
      const cur = Math.min(pageInfo.pages, Math.floor(el.scrollTop / sheetStepRef.current) * 2 + 1);
      if (cur !== pageInfo.current) setPageInfo((p) => ({ ...p, current: cur }));
      return;
    }
    const heads = contentRef.current?.querySelectorAll<HTMLElement>('.md-heading');
    if (heads) {
      let cur = '';
      for (const h of Array.from(heads)) {
        if (h.offsetTop - el.scrollTop <= 80) cur = h.id;
        else break;
      }
      if (cur) setActiveSlug(cur);
    }
  }, [docKey, paged, pageInfo.pages, pageInfo.current]);

  const flipSheet = useCallback((dir: 1 | -1) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollBy({ top: dir * sheetStepRef.current, behavior: 'smooth' });
  }, []);

  const changeFont = (delta: number) =>
    setPrefs((p) => ({ ...p, fontScale: clampFont(p.fontScale + delta) }));

  const setMode = (mode: ReaderMode) => setPrefs((p) => ({ ...p, mode }));

  const jump = (slug: string) => {
    const el = bodyRef.current;
    if (!el) return;
    if (paged) {
      const target = pagesRef.current?.querySelector<HTMLElement>(`#${cssEscape(slug)}`);
      const sheet = target?.closest<HTMLElement>('.reader-sheet');
      if (sheet) el.scrollTo({ top: sheet.offsetTop - 8, behavior: 'smooth' });
    } else if (contentRef.current) {
      scrollToSlug(contentRef.current, slug);
    }
    setActiveSlug(slug);
  };

  const toggleFullscreen = () => {
    const node = rootRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  };

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
          <div ref={bodyRef} className="reader-body" onScroll={onScroll}>
            {/* 连续模式正文 / 双页模式的测量源（双页时隐藏） */}
            <div ref={contentRef} className="reader-content markdown-body" />
            {/* 双页模式：堆叠的纸页（由 JS 填充） */}
            <div ref={pagesRef} className="reader-pages markdown-body" />
          </div>

          {paged && (
            <>
              <button
                type="button"
                className="reader-flip reader-flip-prev"
                title="上一张"
                onClick={() => flipSheet(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="reader-flip reader-flip-next"
                title="下一张"
                onClick={() => flipSheet(1)}
              >
                ›
              </button>
              <div className="reader-pagebar">
                第 {pageInfo.current} 页 · 共 {pageInfo.pages} 页
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
