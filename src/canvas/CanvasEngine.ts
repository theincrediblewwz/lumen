/**
 * CanvasEngine —— 白板视口（平移/缩放）与坐标换算内核（M2-1）
 *
 * 设计对应 docs/DESIGN.md §5.4：
 *   「视口（平移/缩放）变换、坐标换算（屏幕↔世界）、网格绘制」
 * 性能策略（§5.4）：平移/缩放只改容器 transform（translate + scale），
 * 不逐个重排节点；视口外节点按包围盒剔除（虚拟化）。
 *
 * 坐标模型
 * --------
 * 世界坐标（world）：节点在无限画布上的逻辑位置，存于 board.json 的 node.x/node.y。
 * 屏幕坐标（screen）：相对**画布容器左上角**的像素坐标（不是浏览器 client 坐标；
 *   client 坐标须先减去容器 getBoundingClientRect().left/top，见 clientToCanvas）。
 *
 * 容器 transform 与本模块约定一致：`translate(vp.x, vp.y) scale(vp.zoom)`
 *   screen = world * zoom + (vp.x, vp.y)
 *   world  = (screen - (vp.x, vp.y)) / zoom
 *
 * 本文件的**纯函数**部分不依赖 DOM，可在 Node 侧直接单测（DESIGN §8）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 视口：世界原点在屏幕上的偏移 (x,y) + 缩放 zoom。与 board.json.viewport 同构。 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** 缩放范围与默认配置。 */
export interface CanvasEngineOptions {
  minZoom?: number;
  maxZoom?: number;
  /** fitToBounds 时四周留白（屏幕像素）。 */
  fitPadding?: number;
}

export const DEFAULT_MIN_ZOOM = 0.1;
export const DEFAULT_MAX_ZOOM = 4;
export const DEFAULT_FIT_PADDING = 48;
export const IDENTITY_VIEWPORT: Readonly<Viewport> = Object.freeze({ x: 0, y: 0, zoom: 1 });

/* ────────────────────────── 纯函数核心 ────────────────────────── */

/** 把 zoom 夹到 [min,max]；对 NaN/非有限值回退到 1。 */
export function clampZoom(
  zoom: number,
  minZoom: number = DEFAULT_MIN_ZOOM,
  maxZoom: number = DEFAULT_MAX_ZOOM,
): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return clampZoom(1, minZoom, maxZoom);
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

/** 世界坐标 → 屏幕坐标（相对画布容器左上角）。 */
export function worldToScreen(vp: Viewport, world: Vec2): Vec2 {
  return {
    x: world.x * vp.zoom + vp.x,
    y: world.y * vp.zoom + vp.y,
  };
}

/** 屏幕坐标（相对画布容器左上角）→ 世界坐标。 */
export function screenToWorld(vp: Viewport, screen: Vec2): Vec2 {
  return {
    x: (screen.x - vp.x) / vp.zoom,
    y: (screen.y - vp.y) / vp.zoom,
  };
}

/** 浏览器 client 坐标（如鼠标事件 clientX/Y）→ 画布容器局部屏幕坐标。 */
export function clientToCanvas(client: Vec2, canvasRect: { left: number; top: number }): Vec2 {
  return { x: client.x - canvasRect.left, y: client.y - canvasRect.top };
}

/**
 * 以某个屏幕锚点为中心缩放，使锚点下的**世界点保持不动**（滚轮/捏合缩放的核心）。
 * 返回新视口；原视口不被修改。
 */
export function zoomAtPoint(
  vp: Viewport,
  screenAnchor: Vec2,
  nextZoom: number,
  minZoom: number = DEFAULT_MIN_ZOOM,
  maxZoom: number = DEFAULT_MAX_ZOOM,
): Viewport {
  const z = clampZoom(nextZoom, minZoom, maxZoom);
  // 锚点当前对应的世界点，缩放后仍要落在同一屏幕锚点上。
  const world = screenToWorld(vp, screenAnchor);
  return {
    zoom: z,
    x: screenAnchor.x - world.x * z,
    y: screenAnchor.y - world.y * z,
  };
}

/** 按倍率缩放（factor>1 放大），锚点保持不动。等价于 zoomAtPoint(vp, anchor, zoom*factor)。 */
export function zoomByFactor(
  vp: Viewport,
  screenAnchor: Vec2,
  factor: number,
  minZoom: number = DEFAULT_MIN_ZOOM,
  maxZoom: number = DEFAULT_MAX_ZOOM,
): Viewport {
  return zoomAtPoint(vp, screenAnchor, vp.zoom * factor, minZoom, maxZoom);
}

/** 按屏幕像素增量平移视口（缩放不变）。返回新视口。 */
export function panByScreen(vp: Viewport, deltaScreen: Vec2): Viewport {
  return { ...vp, x: vp.x + deltaScreen.x, y: vp.y + deltaScreen.y };
}

/** 按世界坐标增量平移视口（内部换算成屏幕像素）。 */
export function panByWorld(vp: Viewport, deltaWorld: Vec2): Viewport {
  return { ...vp, x: vp.x - deltaWorld.x * vp.zoom, y: vp.y - deltaWorld.y * vp.zoom };
}

/** 把某个世界点平移到屏幕上的指定位置（缩放不变），如「双击定位到节点」。 */
export function centerWorldPointAt(vp: Viewport, world: Vec2, screenTarget: Vec2): Viewport {
  return {
    ...vp,
    x: screenTarget.x - world.x * vp.zoom,
    y: screenTarget.y - world.y * vp.zoom,
  };
}

/**
 * 计算「一组世界包围盒」在给定视口尺寸下的最佳适配视口（fit / zoom-to-fit）。
 * bounds 为空或退化时回退为居中、zoom=1。
 */
export function fitToBounds(
  worldBounds: Rect | null | undefined,
  viewportSize: Size,
  opts: CanvasEngineOptions = {},
): Viewport {
  const minZoom = opts.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = opts.maxZoom ?? DEFAULT_MAX_ZOOM;
  const pad = opts.fitPadding ?? DEFAULT_FIT_PADDING;
  const { width: vw, height: vh } = viewportSize;

  if (!worldBounds || worldBounds.width <= 0 || worldBounds.height <= 0) {
    // 无内容：世界原点放到视口中心，zoom=1。
    return { x: vw / 2, y: vh / 2, zoom: clampZoom(1, minZoom, maxZoom) };
  }

  const availW = Math.max(1, vw - pad * 2);
  const availH = Math.max(1, vh - pad * 2);
  const zoom = clampZoom(
    Math.min(availW / worldBounds.width, availH / worldBounds.height),
    minZoom,
    maxZoom,
  );

  const worldCenter: Vec2 = {
    x: worldBounds.x + worldBounds.width / 2,
    y: worldBounds.y + worldBounds.height / 2,
  };
  return centerWorldPointAt({ x: 0, y: 0, zoom }, worldCenter, { x: vw / 2, y: vh / 2 });
}

/** 当前视口在世界坐标系中可见的矩形（用于节点虚拟化/剔除）。 */
export function visibleWorldRect(vp: Viewport, viewportSize: Size): Rect {
  const tl = screenToWorld(vp, { x: 0, y: 0 });
  const br = screenToWorld(vp, { x: viewportSize.width, y: viewportSize.height });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

/** 两个世界矩形是否相交（含 margin 扩边，用于「视口外一圈也预挂载」）。 */
export function rectsIntersect(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.width &&
    a.x + a.width + margin > b.x &&
    a.y - margin < b.y + b.height &&
    a.y + a.height + margin > b.y
  );
}

/** 某个世界矩形是否在当前视口内可见（margin 为世界坐标的扩边）。 */
export function isWorldRectVisible(
  vp: Viewport,
  viewportSize: Size,
  worldRect: Rect,
  margin = 0,
): boolean {
  return rectsIntersect(visibleWorldRect(vp, viewportSize), worldRect, margin);
}

/** 生成容器 CSS transform 字符串（GPU 合成：translate3d + scale）。 */
export function viewportToTransform(vp: Viewport): string {
  return `translate3d(${vp.x}px, ${vp.y}px, 0) scale(${vp.zoom})`;
}

/* ────────────────────────── 有状态封装 ────────────────────────── */

/**
 * CanvasEngine —— 持有当前视口状态的薄封装，方法委托给上面的纯函数。
 * 不直接操作 DOM：把画布容器的 getBoundingClientRect() 作为参数传入即可。
 */
export class CanvasEngine {
  private vp: Viewport;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly fitPadding: number;

  constructor(initial: Partial<Viewport> = {}, opts: CanvasEngineOptions = {}) {
    this.minZoom = opts.minZoom ?? DEFAULT_MIN_ZOOM;
    this.maxZoom = opts.maxZoom ?? DEFAULT_MAX_ZOOM;
    this.fitPadding = opts.fitPadding ?? DEFAULT_FIT_PADDING;
    this.vp = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      zoom: clampZoom(initial.zoom ?? 1, this.minZoom, this.maxZoom),
    };
  }

  /** 当前视口（只读副本，避免外部误改内部状态）。 */
  get viewport(): Viewport {
    return { ...this.vp };
  }

  /** 覆盖设置视口（zoom 会被夹到范围内）。 */
  setViewport(vp: Viewport): this {
    this.vp = { x: vp.x, y: vp.y, zoom: clampZoom(vp.zoom, this.minZoom, this.maxZoom) };
    return this;
  }

  toScreen(world: Vec2): Vec2 {
    return worldToScreen(this.vp, world);
  }

  toWorld(screen: Vec2): Vec2 {
    return screenToWorld(this.vp, screen);
  }

  /** 从浏览器 client 坐标（鼠标事件）直接换算到世界坐标。 */
  clientToWorld(client: Vec2, canvasRect: { left: number; top: number }): Vec2 {
    return screenToWorld(this.vp, clientToCanvas(client, canvasRect));
  }

  panByScreen(deltaScreen: Vec2): this {
    this.vp = panByScreen(this.vp, deltaScreen);
    return this;
  }

  zoomAtPoint(screenAnchor: Vec2, nextZoom: number): this {
    this.vp = zoomAtPoint(this.vp, screenAnchor, nextZoom, this.minZoom, this.maxZoom);
    return this;
  }

  zoomByFactor(screenAnchor: Vec2, factor: number): this {
    this.vp = zoomByFactor(this.vp, screenAnchor, factor, this.minZoom, this.maxZoom);
    return this;
  }

  fit(worldBounds: Rect | null | undefined, viewportSize: Size): this {
    this.vp = fitToBounds(worldBounds, viewportSize, {
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      fitPadding: this.fitPadding,
    });
    return this;
  }

  visibleWorldRect(viewportSize: Size): Rect {
    return visibleWorldRect(this.vp, viewportSize);
  }

  isVisible(viewportSize: Size, worldRect: Rect, margin = 0): boolean {
    return isWorldRectVisible(this.vp, viewportSize, worldRect, margin);
  }

  get transform(): string {
    return viewportToTransform(this.vp);
  }
}
