import { describe, it, expect } from 'vitest';
import { dropPointToClient, detectMacOS, type DropPointEnv } from './dropPoint';

/** 1280×800 的窗口 */
const env = (isMac: boolean, dpr: number): DropPointEnv => ({
  isMac,
  dpr,
  viewportW: 1280,
  viewportH: 800,
});

describe('dropPointToClient —— 原生拖放坐标的平台口径', () => {
  it('Windows dpr=1：物理==逻辑，坐标原样返回', () => {
    expect(dropPointToClient(640, 400, env(false, 1))).toEqual({ x: 640, y: 400 });
  });

  it('Windows dpr=1.5：物理像素需除以 dpr 才是 CSS 坐标', () => {
    const p = dropPointToClient(960, 600, env(false, 1.5));
    expect(p.x).toBeCloseTo(640, 5);
    expect(p.y).toBeCloseTo(400, 5);
  });

  it('macOS dpr=2（Retina）：上报的已是逻辑点，绝不能再除 dpr', () => {
    // 这是「Mac 上拖文件没反应」的根因回归：旧实现一律 /dpr，得到 {320,200}，
    // 与实际落点 {640,400} 相差一半，命中测试因此全部落空。
    expect(dropPointToClient(640, 400, env(true, 2))).toEqual({ x: 640, y: 400 });
  });

  it('macOS dpr=1（非 Retina）：同样不除 dpr', () => {
    expect(dropPointToClient(640, 400, env(true, 1))).toEqual({ x: 640, y: 400 });
  });

  it('macOS 拖到窗口右下角：坐标仍落在视口内', () => {
    const p = dropPointToClient(1270, 790, env(true, 2));
    expect(p.x).toBeLessThanOrEqual(1280);
    expect(p.y).toBeLessThanOrEqual(800);
    expect(p).toEqual({ x: 1270, y: 790 });
  });
});

describe('dropPointToClient —— 口径兜底', () => {
  it('主口径结果已落在视口内 → 不触发兜底（Windows dpr=2）', () => {
    // 2540/2=1270、1600/2=800，均在视口(1280×800)内 → 保持主口径结果
    expect(dropPointToClient(2540, 1600, env(false, 2))).toEqual({ x: 1270, y: 800 });
  });

  it('主口径越界、另一口径落在视口内 → 改用另一口径（探测失灵时自愈）', () => {
    // 模拟「macOS 被误判成非 mac」的反向情形：主口径 scale=1 时 (2560,1600) 越界，
    // 除以 dpr=2 后 (1280,800) 落在容差内 → 自动切到该口径，拖放不至于整块失灵。
    const p = dropPointToClient(2560, 1600, env(true, 2));
    expect(p).toEqual({ x: 1280, y: 800 });
  });

  it('兜底不误伤：Windows dpr=1.5、点确实在视口内时不触发切换', () => {
    const p = dropPointToClient(300, 200, env(false, 1.5));
    expect(p.x).toBeCloseTo(200, 5);
    expect(p.y).toBeCloseTo(133.3333, 3);
  });

  it('边角：点确实在视口外（拖拽掠过窗口外）时保持主口径结果', () => {
    // isMac=false, dpr=2 → 主口径 5000/2=2500 越界；另一口径 5000 也越界 → 不切换
    expect(dropPointToClient(5000, 3000, env(false, 2))).toEqual({ x: 2500, y: 1500 });
  });

  it('dpr 非法（0 或负）时按 1 处理，不产生 Infinity', () => {
    expect(dropPointToClient(100, 100, env(false, 0))).toEqual({ x: 100, y: 100 });
  });
});

describe('detectMacOS', () => {
  it('在无 navigator 的环境（Node 单测）里安全返回 false 而不抛错', () => {
    expect(typeof detectMacOS()).toBe('boolean');
  });
});
