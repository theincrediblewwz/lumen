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
const GAP = 40; // 左右两页之间的中缝
const PAGE_PAD_X = 40; // 每页左右内边距
const PAGE_PAD_Y = 40; // 每页上下内边距
const SHEET_GAP = 24; // 相邻纸行之间的竖直间距

/**
 * 阅读器视图（M4 + 阅读体验增强）。既用于应用内浮层，也用于独立窗口。
 * - 主题跟随软件主体（ADR-027）
 * - 顶栏：标题、字号、阅读模式（单页 / 双页）、全屏、关闭、（独立窗）窗口控制
 * - 左侧：目录（TOC，含公式渲染，可收起）
 * - 单页（single）：一栏连续滚动，充分利用整宽（窗口越大/全屏越铺满左右）
 * - 双页（double，ADR-031）：像 PDF「双页连续」——每行左右两页并排、向下连续滚动。
 *   用实时布局把顶层块贪心装进「页高≈视口」的一页页里（块不拆分、装不下就换页留白，
 *   绝不把公式/段落截一半），每两页拼成一行，纸行竖直堆叠。
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
  const contentRef = useRef<HTMLDivElement>(null); // 单页正文 / 双页测量源
  const pagesRef = useRef<HTMLDivElement>(null); // 双页：堆叠的纸行
  const tocRef = useRef<HTMLDivElement>(null);
  const pageStepRef = useRef(1); // 一行纸的竖直步长（翻页用）
  const restoredRef = useRef(false);

  const double = prefs.mode === 'double';
  const tocCollapsed = !!prefs.tocCollapsed;

  const { html, toc } = useMemo(
    () => renderMarkdown(markdown, undefined, { guessMath }),
    [markdown, guessMath],
  );

  useEffect(() => savePrefs(prefs), [prefs]);

  /**
   * 双页分页：用「真实布局」把 contentRef 里的顶层块贪心装进一页页。
   * 每页宽 colW、目标高 colH；逐块 append 到当前页，若溢出则退回该块另起一页
   * （块本身不拆分，装不下就在页尾留白——不会把公式/段落截断）。每两页拼一行。
   */
  const paginate = useCallback(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!body || !content || !pages) return;

    const bodyW = body.clientWidth;
    // 两页并排：每页宽 = (可用宽 - 中缝 - 四个内边距) / 2
    const colW = Math.max(240, Math.floor((bodyW - GAP - 4 * PAGE_PAD_X) / 2));
    const colH = Math.max(320, body.clientHeight - 2 * PAGE_PAD_Y - SHEET_GAP);

    const blocks = Array.from(content.children) as HTMLElement[];

    // 离屏测量宿主：一列列真实布局，量 scrollHeight
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${colW}px;`;
    host.className = 'markdown-body';
    host.style.setProperty('--reader-font-scale', String(prefs.fontScale / 100));
    pages.appendChild(host);

    const mkPage = () => {
      const p = document.createElement('div');
      p.className = 'reader-page-col';
      p.style.width = `${colW}px`;
      p.style.minHeight = `${colH}px`;
      host.appendChild(p);
      return p;
    };

    const pageCols: HTMLElement[] = [];
    let cur = mkPage();
    pageCols.push(cur);
    for (const block of blocks) {
      cur.appendChild(block);
      if (cur.childElementCount > 1 && cur.scrollHeight > colH) {
        cur.removeChild(block);
        cur = mkPage();
        pageCols.push(cur);
        cur.appendChild(block);
      }
    }

    // 组装纸行（每两页一行：左页 + 中缝 + 右页）
    pages.innerHTML = '';
    for (let i = 0; i < pageCols.length; i += 2) {
      const sheet = document.createElement('div');
      sheet.className = 'reader-sheet';
      sheet.style.columnGap = `${GAP}px`;

      const leftPage = document.createElement('div');
      leftPage.className = 'reader-page';
      leftPage.style.padding = `${PAGE_PAD_Y}px ${PAGE_PAD_X}px`;
      leftPage.style.minHeight = `${colH}px`;
      const leftCol = pageCols[i];
      leftCol.style.minHeight = '';
      leftPage.appendChild(leftCol);
      const pnL = document.createElement('span');
      pnL.className = 'reader-page-pn';
      pnL.textContent = String(i + 1);
      leftPage.appendChild(pnL);
      sheet.appendChild(leftPage);

      if (pageCols[i + 1]) {
        const rightPage = document.createElement('div');
        rightPage.className = 'reader-page';
        rightPage.style.padding = `${PAGE_PAD_Y}px ${PAGE_PAD_X}px`;
        rightPage.style.minHeight = `${colH}px`;
        const rightCol = pageCols[i + 1];
        rightCol.style.minHeight = '';
        rightPage.appendChild(rightCol);
        const pnR = document.createElement('span');
        pnR.className = 'reader-page-pn';
        pnR.textContent = String(i + 2);
        rightPage.appendChild(pnR);
        sheet.appendChild(rightPage);
      } else {
        // 落单的最后一页：右侧放个占位空页，保持左右对齐
        const ph = document.createElement('div');
        ph.className = 'reader-page is-placeholder';
        ph.style.minHeight = `${colH}px`;
        sheet.appendChild(ph);
      }
      pages.appendChild(sheet);
    }
    host.remove();

    const firstSheet = pages.querySelector<HTMLElement>('.reader-sheet');
    pageStepRef.current = firstSheet ? firstSheet.offsetHeight + SHEET_GAP : body.clientHeight;
    setPageInfo({ pages: pageCols.length, current: 1 });
  }, [prefs.fontScale]);

  // 把双页纸行里的块搬回测量源（重排前）
  const collectBack = useCallback(() => {
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!content || !pages) return;
    const cols = pages.querySelectorAll<HTMLElement>('.reader-page-col');
    cols.forEach((c) => {
      while (c.firstChild) content.appendChild(c.firstChild);
    });
    pages.innerHTML = '';
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
      if (double) paginate();
      if (restoredRef.current) return;
      restoredRef.current = true;
      const ratio = getProgress(docKey);
      requestAnimationFrame(() => {
        const el = bodyRef.current;
        if (!el || ratio <= 0) return;
        el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
      });
    });

    return () => {
      cancelled = true;
      handle.cancel();
      tocHandle?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, docKey, double]);

  // 视口尺寸变化：双页重新分页
  useEffect(() => {
    if (!double) return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        collectBack();
        paginate();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [double, paginate, collectBack]);

  // 字号变化（双页）重新分页
  useEffect(() => {
    if (!double) return;
    const pages = pagesRef.current;
    if (!pages || pages.querySelectorAll('.reader-page-col').length === 0) return;
    collectBack();
    paginate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.fontScale]);

  // 全屏状态跟随（全屏后双页需重排）
  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (double) {
        requestAnimationFrame(() => {
          collectBack();
          paginate();
        });
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [double, paginate, collectBack]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const denom = el.scrollHeight - el.clientHeight;
    if (denom > 0) setProgress(docKey, el.scrollTop / denom);
    if (double) {
      const row = Math.floor(el.scrollTop / pageStepRef.current);
      const cur = Math.min(pageInfo.pages, row * 2 + 1);
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
  }, [docKey, double, pageInfo.pages, pageInfo.current]);

  const flipRow = useCallback((dir: 1 | -1) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollBy({ top: dir * pageStepRef.current, behavior: 'smooth' });
  }, []);

  const changeFont = (delta: number) =>
    setPrefs((p) => ({ ...p, fontScale: clampFont(p.fontScale + delta) }));

  const setMode = (mode: ReaderMode) => setPrefs((p) => ({ ...p, mode }));
  const toggleToc = () => setPrefs((p) => ({ ...p, tocCollapsed: !p.tocCollapsed }));

  const jump = (slug: string) => {
    const el = bodyRef.current;
    if (!el) return;
    if (double) {
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
  const showToc = toc.length > 0 && !isFullscreen && !tocCollapsed;

  return (
    <div
      ref={rootRef}
      className={`reader${standalone ? ' is-standalone' : ''}${double ? ' is-double' : ' is-single'}${
        isFullscreen ? ' is-fullscreen' : ''
      }`}
      style={{ ['--reader-font-scale' as string]: String(prefs.fontScale / 100) }}
    >
      <header
        className={`reader-bar${standalone ? ' is-standalone-bar' : ''}${isMac && standalone ? ' is-mac' : ''}`}
        {...(standalone ? { 'data-tauri-drag-region': true } : {})}
      >
        {toc.length > 0 && !isFullscreen && (
          <button
            type="button"
            className={`reader-btn reader-icon reader-toc-toggle${tocCollapsed ? '' : ' is-active'}`}
            title={tocCollapsed ? '展开目录' : '收起目录'}
            onClick={toggleToc}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4h12M2 8h9M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <h1 className="reader-title" title={title} {...(standalone ? { 'data-tauri-drag-region': true } : {})}>{title}</h1>
        <div className="reader-tools">
          <div className="reader-seg">
            <button
              type="button"
              className={`reader-btn${!double ? ' is-active' : ''}`}
              title="单页连续"
              onClick={() => setMode('single')}
            >
              单页
            </button>
            <button
              type="button"
              className={`reader-btn${double ? ' is-active' : ''}`}
              title="双页连续"
              onClick={() => setMode('double')}
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
        {showToc && (
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
            {/* 单页正文 / 双页测量源（双页时隐藏用于量块高） */}
            <div ref={contentRef} className="reader-content markdown-body" />
            {/* 双页：堆叠的纸行（由 JS 填充） */}
            <div ref={pagesRef} className="reader-pages markdown-body" />
          </div>

          {double && (
            <>
              <button
                type="button"
                className="reader-flip reader-flip-prev"
                title="上一行"
                onClick={() => flipRow(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="reader-flip reader-flip-next"
                title="下一行"
                onClick={() => flipRow(1)}
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
