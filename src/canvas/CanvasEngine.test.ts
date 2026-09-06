import { describe, it, expect } from 'vitest';
import {
  CanvasEngine,
  clampZoom,
  worldToScreen,
  screenToWorld,
  clientToCanvas,
  zoomAtPoint,
  zoomByFactor,
  panByScreen,
  panByWorld,
  centerWorldPointAt,
  fitToBounds,
  visibleWorldRect,
  rectsIntersect,
  isWorldRectVisible,
  viewportToTransform,
  DEFAULT_MIN_ZOOM,
  DEFAULT_MAX_ZOOM,
  type Viewport,
  type Vec2,
} from './CanvasEngine';

const approx = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
};

describe('clampZoom', () => {
  it('夹在默认范围内', () => {
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(100)).toBe(DEFAULT_MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(DEFAULT_MIN_ZOOM);
  });
  it('尊重自定义范围', () => {
    expect(clampZoom(5, 0.5, 3)).toBe(3);
    expect(clampZoom(0.1, 0.5, 3)).toBe(0.5);
  });
  it('对非法值回退为 1（再夹范围）', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(-3)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1); // Infinity 非有限 -> 回退为 1
  });
});

describe('worldToScreen / screenToWorld 互逆', () => {
  const vp: Viewport = { x: 120, y: -40, zoom: 1.5 };
  it('平移单位映射正确', () => {
    // world 原点 -> 屏幕上的 (vp.x, vp.y)
    approx(worldToScreen(vp, { x: 0, y: 0 }), { x: 120, y: -40 });
    // world (10,10) -> 10*1.5 + offset
    approx(worldToScreen(vp, { x: 10, y: 10 }), { x: 135, y: -25 });
  });
  it('往返一致（round-trip）', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 33.3, y: -77.7 },
      { x: 1000, y: 2000 },
    ];
    for (const p of pts) {
      approx(screenToWorld(vp, worldToScreen(vp, p)), p, 1e-6);
    }
  });
  it('zoom=1 且无偏移时为恒等', () => {
    const id: Viewport = { x: 0, y: 0, zoom: 1 };
    approx(worldToScreen(id, { x: 42, y: -13 }), { x: 42, y: -13 });
  });
});

describe('clientToCanvas', () => {
  it('减去容器左上角', () => {
    approx(clientToCanvas({ x: 200, y: 150 }, { left: 40, top: 20 }), { x: 160, y: 130 });
  });
});

describe('zoomAtPoint —— 锚点世界点保持不动', () => {
  it('放大后锚点下的世界点仍映射回同一屏幕位置', () => {
    const vp: Viewport = { x: 50, y: 30, zoom: 1 };
    const anchor: Vec2 = { x: 300, y: 220 };
    const worldUnder = screenToWorld(vp, anchor);
    const next = zoomAtPoint(vp, anchor, 2.5);
    expect(next.zoom).toBe(2.5);
    approx(worldToScreen(next, worldUnder), anchor, 1e-6);
  });
  it('缩放被夹紧时锚点依然不动', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 1 };
    const anchor: Vec2 = { x: 100, y: 100 };
    const worldUnder = screenToWorld(vp, anchor);
    const next = zoomAtPoint(vp, anchor, 999); // 会被夹到 maxZoom
    expect(next.zoom).toBe(DEFAULT_MAX_ZOOM);
    approx(worldToScreen(next, worldUnder), anchor, 1e-6);
  });
  it('不修改原视口（纯函数）', () => {
    const vp: Viewport = { x: 5, y: 7, zoom: 1 };
    const snapshot = { ...vp };
    zoomAtPoint(vp, { x: 10, y: 10 }, 3);
    expect(vp).toEqual(snapshot);
  });
});

describe('zoomByFactor', () => {
  it('倍率等价于绝对缩放', () => {
    const vp: Viewport = { x: 10, y: 10, zoom: 1.2 };
    const anchor: Vec2 = { x: 80, y: 60 };
    const byFactor = zoomByFactor(vp, anchor, 2);
    const byAbs = zoomAtPoint(vp, anchor, 2.4);
    expect(byFactor.zoom).toBeCloseTo(byAbs.zoom, 9);
    approx(byFactor, byAbs, 1e-9);
  });
});

describe('panByScreen / panByWorld', () => {
  it('屏幕平移直接叠加偏移，不动 zoom', () => {
    const vp: Viewport = { x: 100, y: 100, zoom: 2 };
    const next = panByScreen(vp, { x: -30, y: 15 });
    expect(next).toEqual({ x: 70, y: 115, zoom: 2 });
  });
  it('世界平移 d 使内容向反方向滚动 d*zoom 像素', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 2 };
    // 世界视图向右移动 10 => 偏移减少 20 像素
    const next = panByWorld(vp, { x: 10, y: 0 });
    expect(next.x).toBe(-20);
    // 平移后，原本世界 (10,0) 现在落到屏幕原点
    approx(worldToScreen(next, { x: 10, y: 0 }), { x: 0, y: 0 });
  });
});

describe('centerWorldPointAt', () => {
  it('把世界点对齐到指定屏幕位置', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 1.5 };
    const next = centerWorldPointAt(vp, { x: 200, y: 100 }, { x: 400, y: 300 });
    approx(worldToScreen(next, { x: 200, y: 100 }), { x: 400, y: 300 }, 1e-6);
    expect(next.zoom).toBe(1.5);
  });
});

describe('fitToBounds', () => {
  const size = { width: 800, height: 600 };
  it('把包围盒居中并按短边适配（含留白）', () => {
    const bounds = { x: 0, y: 0, width: 400, height: 200 };
    const vp = fitToBounds(bounds, size, { fitPadding: 0 });
    // 可用 800/400=2, 600/200=3 -> 取 min=2
    expect(vp.zoom).toBe(2);
    // 包围盒中心 (200,100) 应落在视口中心 (400,300)
    approx(worldToScreen(vp, { x: 200, y: 100 }), { x: 400, y: 300 }, 1e-6);
  });
  it('留白使缩放更小', () => {
    const bounds = { x: 0, y: 0, width: 400, height: 200 };
    const noPad = fitToBounds(bounds, size, { fitPadding: 0 });
    const withPad = fitToBounds(bounds, size, { fitPadding: 50 });
    expect(withPad.zoom).toBeLessThan(noPad.zoom);
  });
  it('空/退化包围盒 -> 居中且 zoom=1', () => {
    const vp = fitToBounds(null, size);
    expect(vp).toEqual({ x: 400, y: 300, zoom: 1 });
    const vp2 = fitToBounds({ x: 0, y: 0, width: 0, height: 0 }, size);
    expect(vp2.zoom).toBe(1);
  });
  it('缩放不超过 maxZoom（极小包围盒）', () => {
    const vp = fitToBounds({ x: 0, y: 0, width: 1, height: 1 }, size, { fitPadding: 0 });
    expect(vp.zoom).toBe(DEFAULT_MAX_ZOOM);
  });
});

describe('visibleWorldRect / 可见性剔除', () => {
  it('恒等视口下可见区域等于视口尺寸', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 1 };
    expect(visibleWorldRect(vp, { width: 800, height: 600 })).toEqual({
      x: 0, y: 0, width: 800, height: 600,
    });
  });
  it('放大后可见世界区域变小', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 2 };
    const r = visibleWorldRect(vp, { width: 800, height: 600 });
    expect(r.width).toBe(400);
    expect(r.height).toBe(300);
  });
  it('rectsIntersect 基本判定 + margin', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 20, y: 0, width: 5, height: 5 })).toBe(false);
    // margin 扩边后相交
    expect(rectsIntersect(a, { x: 20, y: 0, width: 5, height: 5 }, 15)).toBe(true);
  });
  it('isWorldRectVisible 剔除视口外节点', () => {
    const vp: Viewport = { x: 0, y: 0, zoom: 1 };
    const size = { width: 800, height: 600 };
    expect(isWorldRectVisible(vp, size, { x: 100, y: 100, width: 50, height: 30 })).toBe(true);
    expect(isWorldRectVisible(vp, size, { x: 2000, y: 2000, width: 50, height: 30 })).toBe(false);
  });
});

describe('viewportToTransform', () => {
  it('生成 translate3d + scale', () => {
    expect(viewportToTransform({ x: 12, y: -8, zoom: 1.25 })).toBe(
      'translate3d(12px, -8px, 0) scale(1.25)',
    );
  });
});

describe('CanvasEngine 类封装', () => {
  it('构造时夹紧 zoom，viewport 返回副本', () => {
    const e = new CanvasEngine({ x: 10, y: 20, zoom: 999 });
    expect(e.viewport).toEqual({ x: 10, y: 20, zoom: DEFAULT_MAX_ZOOM });
    const v = e.viewport;
    v.x = 5;
    expect(e.viewport.x).toBe(10); // 未被外部篡改
  });
  it('链式 pan/zoom 且坐标往返一致', () => {
    const e = new CanvasEngine();
    e.panByScreen({ x: 100, y: 50 }).zoomByFactor({ x: 200, y: 200 }, 2);
    const w = e.toWorld({ x: 320, y: 240 });
    approx(e.toScreen(w), { x: 320, y: 240 }, 1e-6);
  });
  it('clientToWorld 先扣容器偏移再换算', () => {
    const e = new CanvasEngine({ x: 0, y: 0, zoom: 2 });
    const rect = { left: 40, top: 20 };
    // client (240,120) -> canvas (200,100) -> world (100,50)
    approx(e.clientToWorld({ x: 240, y: 120 }, rect), { x: 100, y: 50 }, 1e-6);
  });
  it('zoomAtPoint 保持锚点世界点不动', () => {
    const e = new CanvasEngine({ x: 30, y: 30, zoom: 1 });
    const anchor = { x: 250, y: 180 };
    const before = e.toWorld(anchor);
    e.zoomAtPoint(anchor, 3);
    approx(e.toScreen(before), anchor, 1e-6);
    expect(e.viewport.zoom).toBe(3);
  });
  it('fit 后包围盒中心落在视口中心', () => {
    const e = new CanvasEngine();
    e.fit({ x: -100, y: -100, width: 200, height: 200 }, { width: 600, height: 600 });
    approx(e.toScreen({ x: 0, y: 0 }), { x: 300, y: 300 }, 1e-6);
  });
  it('isVisible 委托剔除逻辑', () => {
    const e = new CanvasEngine();
    const size = { width: 800, height: 600 };
    expect(e.isVisible(size, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(e.isVisible(size, { x: -500, y: -500, width: 20, height: 20 })).toBe(false);
  });
  it('transform 反映当前视口', () => {
    const e = new CanvasEngine({ x: 5, y: 6, zoom: 1 });
    expect(e.transform).toBe('translate3d(5px, 6px, 0) scale(1)');
  });
});
