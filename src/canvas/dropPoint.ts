/**
 * 原生拖放（OS 文件拖入）坐标 → 视口 CSS 坐标的换算。纯逻辑，可单测。
 *
 * ## 为什么需要这个模块
 * Tauri 的原生拖放事件（tauri://drag-drop）payload 里的 position
 * **在不同平台上口径不一致**，但对外契约却统一声明为物理像素：
 *
 * | 平台 | wry 实现 | 上报值 |
 * | --- | --- | --- |
 * | Windows | `webview2/drag_drop.rs:167,184` — `ScreenToClient(pt)` 后 `position: (pt.x, pt.y)` | **物理像素** |
 * | macOS   | `wkwebview/drag_drop.rs:42` — `(dl.x, frame.size.height - dl.y)`，NSPoint/NSRect 以「点」计 | **逻辑像素(CSS px)** |
 * | Linux   | `webkitgtk/drag_drop.rs` | 物理像素 |
 *
 * 两边到 `tauri-runtime-wry/src/lib.rs:4872` 都被**原样**包成
 * `PhysicalPosition::new(x, y)` 且不做任何缩放，而
 * `tauri-runtime/src/window.rs:103` 把字段声明为 `dpi::PhysicalPosition<f64>`。
 *
 * 于是：macOS 上报的其实是逻辑点，调用方若再除一次 `devicePixelRatio`，
 * Retina(dpr=2) 上坐标会被砍半 → 命中测试全部落空 →
 * 症状就是「Mac 上拖 .md 到节点没反应，Windows 却正常」。
 *
 * 结论：**macOS 不除 dpr，Windows/Linux 除 dpr**。
 * 升级 tauri/wry 后若上游修正了这个不一致，这里的单测会立刻报警。
 */

export type DropPointEnv = {
  /** 是否 macOS（决定上报值是逻辑点还是物理像素） */
  isMac: boolean;
  /** window.devicePixelRatio */
  dpr: number;
  /** window.innerWidth */
  viewportW: number;
  /** window.innerHeight */
  viewportH: number;
};

/** 视口内判定。留 8px 容差：拖拽掠过窗口边缘时坐标可能略微越界。 */
function inViewport(x: number, y: number, env: DropPointEnv): boolean {
  return x >= -8 && y >= -8 && x <= env.viewportW + 8 && y <= env.viewportH + 8;
}

/**
 * 把原生拖放事件给的坐标换算成视口(CSS)坐标。
 *
 * 除平台口径外，还带一层兜底：当平台探测失灵（主口径把点算到视口外，
 * 而另一口径落在视口内）时自动改用另一口径，避免整块拖放功能失灵。
 */
export function dropPointToClient(
  rawX: number,
  rawY: number,
  env: DropPointEnv,
): { x: number; y: number } {
  const dpr = env.dpr > 0 ? env.dpr : 1;
  // macOS 上报的就是逻辑点，不能再除 dpr；Windows/Linux 上报物理像素，需要除。
  const scale = env.isMac ? 1 : dpr;
  const x = rawX / scale;
  const y = rawY / scale;
  if (inViewport(x, y, env) || dpr === 1) return { x, y };

  const altScale = scale === 1 ? dpr : 1;
  const ax = rawX / altScale;
  const ay = rawY / altScale;
  return inViewport(ax, ay, env) ? { x: ax, y: ay } : { x, y };
}

/** 是否运行在 macOS（从 navigator 探测，供调用方组装 DropPointEnv） */
export function detectMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  return /mac|darwin|macintosh/.test(hint);
}
