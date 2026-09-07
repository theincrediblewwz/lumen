/**
 * 阅读内核 · DOM 排版层（M4-1 控制 + M4-8 分批排版）
 *
 * engine.ts 把公式渲染成占位元素 `<span|div class="math" data-tex="…">`。
 * 这里在内容上屏后，用 KaTeX 对这些占位元素**分批**排版：
 *  - 一次处理一小批（默认 24 个），用 requestAnimationFrame 让出主线程，
 *    保证大文档（几百条公式）滚动/首屏不卡顿。
 *  - 出错的公式就地降级为红色源码，不打断整篇。
 *
 * 依赖 KaTeX（npm），在浏览器/WebView 环境运行；不进入 engine 的纯函数单测。
 */
import katex from 'katex';

export interface TypesetHandle {
  /** 取消尚未完成的分批排版（组件卸载 / 切换文档时调用）。 */
  cancel: () => void;
  /** 排版完成的 Promise（可 await；被 cancel 时也会 resolve）。 */
  done: Promise<void>;
}

/**
 * 对容器内所有 `.math[data-tex]` 占位元素做 KaTeX 排版，分批进行。
 */
export function typesetMath(root: HTMLElement, batchSize = 24): TypesetHandle {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('.math[data-tex]:not([data-done])'),
  );
  let cancelled = false;
  let raf = 0;

  const done = new Promise<void>((resolve) => {
    let i = 0;
    const step = () => {
      if (cancelled) return resolve();
      const end = Math.min(i + batchSize, nodes.length);
      for (; i < end; i++) {
        const el = nodes[i];
        const tex = el.getAttribute('data-tex') ?? '';
        const displayMode = el.classList.contains('math-block');
        try {
          katex.render(tex, el, {
            displayMode,
            throwOnError: false,
            output: 'html',
            strict: false,
          });
        } catch {
          el.textContent = tex;
          el.classList.add('math-error');
        }
        el.setAttribute('data-done', '1');
      }
      if (i < nodes.length) {
        raf = requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    if (nodes.length === 0) resolve();
    else raf = requestAnimationFrame(step);
  });

  return {
    cancel: () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    },
    done,
  };
}

/**
 * 平滑滚动到锚点（标题 slug），并加一段高亮闪烁（M4-5）。
 */
export function scrollToSlug(root: HTMLElement, slug: string) {
  const target = root.querySelector<HTMLElement>(`#${cssEscape(slug)}`);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('anchor-flash');
  // 强制重排以重启动画
  void target.offsetWidth;
  target.classList.add('anchor-flash');
  window.setTimeout(() => target.classList.remove('anchor-flash'), 1600);
  return true;
}

/** CSS.escape 兜底（老 WebView 可能缺失）。 */
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => `\\${c}`);
}
