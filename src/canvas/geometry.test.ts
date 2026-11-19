import { describe, it, expect } from 'vitest';
import {
  boxCenter,
  borderPoint,
  edgeGeometry,
  bentGeometry,
  nearStraightLine,
  straightPath,
  boxContains,
  type Box,
} from './geometry';

const box = (x: number, y: number, w = 100, h = 60): Box => ({ x, y, w, h });

describe('boxCenter', () => {
  it('返回矩形几何中心', () => {
    expect(boxCenter(box(0, 0, 100, 60))).toEqual({ x: 50, y: 30 });
    expect(boxCenter(box(10, 20, 40, 40))).toEqual({ x: 30, y: 40 });
  });
});

describe('borderPoint', () => {
  it('目标在正右方时落在右边框中点', () => {
    const b = box(0, 0, 100, 60);
    const p = borderPoint(b, { x: 500, y: 30 });
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(30);
  });

  it('目标在正上方时落在上边框中点', () => {
    const b = box(0, 0, 100, 60);
    const p = borderPoint(b, { x: 50, y: -500 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(0);
  });

  it('交点始终落在矩形边框上（不在内部、不在外部）', () => {
    const b = box(20, 40, 120, 80);
    for (const t of [
      { x: 400, y: 400 },
      { x: -300, y: 50 },
      { x: 80, y: -200 },
      { x: 500, y: 41 },
    ]) {
      const p = borderPoint(b, t);
      const onLeftRight = Math.abs(p.x - b.x) < 1e-6 || Math.abs(p.x - (b.x + b.w)) < 1e-6;
      const onTopBottom = Math.abs(p.y - b.y) < 1e-6 || Math.abs(p.y - (b.y + b.h)) < 1e-6;
      expect(onLeftRight || onTopBottom).toBe(true);
      // 且落在边框区间内
      expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-6);
      expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-6);
      expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-6);
    }
  });

  it('目标与中心重合时退化为一个边框点而非 NaN', () => {
    const b = box(0, 0, 100, 60);
    const p = borderPoint(b, boxCenter(b));
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('edgeGeometry', () => {
  it('端点分别吸附在两个节点边框上，且方向相对', () => {
    const a = box(0, 0, 100, 60);
    const b = box(300, 0, 100, 60);
    const g = edgeGeometry(a, b);
    // a 在左、b 在右：起点应在 a 的右边框，终点在 b 的左边框
    expect(g.start.x).toBeCloseTo(100);
    expect(g.end.x).toBeCloseTo(300);
  });

  it('生成单段直线，中点在两端点中间', () => {
    const g = edgeGeometry(box(0, 0), box(200, 120));
    expect(g.d).toMatch(/^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/);
    expect(g.mid.x).toBeCloseTo((g.start.x + g.end.x) / 2);
    expect(g.mid.y).toBeCloseTo((g.start.y + g.end.y) / 2);
  });

  it('反向箭头平行且可以分开命中', () => {
    const a = box(0, 0, 100, 60);
    const b = box(300, 0, 100, 60);
    expect(edgeGeometry(a, b, 8).d).toBe('M 100 38 L 300 38');
    expect(edgeGeometry(b, a, 8).d).toBe('M 300 22 L 100 22');
  });
});

describe('straightPath', () => {
  it('输出直线 path', () => {
    expect(straightPath({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe('M 1 2 L 3 4');
  });
});

describe('boxContains', () => {
  const b = box(10, 10, 100, 60);
  it('内部点命中', () => {
    expect(boxContains(b, { x: 50, y: 40 })).toBe(true);
  });
  it('边界点命中', () => {
    expect(boxContains(b, { x: 10, y: 10 })).toBe(true);
    expect(boxContains(b, { x: 110, y: 70 })).toBe(true);
  });
  it('外部点不命中', () => {
    expect(boxContains(b, { x: 200, y: 40 })).toBe(false);
    expect(boxContains(b, { x: 50, y: 200 })).toBe(false);
  });
});


describe('手动弯折', () => {
  const a = box(0, 0, 100, 60);
  const b = box(400, 0, 100, 60);
  it('经过拖出的转角，两端保持吸附', () => {
    const control = { x: 250, y: -100 };
    const geometry = bentGeometry(a, b, control);
    expect(geometry.d).toContain(' Q 250 -100 ');
    expect(geometry.mid).toEqual(control);
    expect(geometry.start.y).toBeCloseTo(0);
    expect(geometry.end.y).toBeCloseTo(0);
  });

  it('吸回直线的范围按屏幕像素计算', () => {
    expect(nearStraightLine(a, b, { x: 250, y: 60 }, 0.5)).toBe(true);
    expect(nearStraightLine(a, b, { x: 250, y: 60 }, 1)).toBe(false);
  });
});
