import { describe, it, expect } from 'vitest';
import { clampToc, TOC_MIN, TOC_MAX, TOC_DEFAULT } from './readerPrefs';

describe('clampToc（目录栏宽度）', () => {
  it('低于下限取下限', () => {
    expect(clampToc(0)).toBe(TOC_MIN);
    expect(clampToc(10)).toBe(TOC_MIN);
  });

  it('高于上限取上限', () => {
    expect(clampToc(9999)).toBe(TOC_MAX);
  });

  it('区间内原样保留并取整', () => {
    expect(clampToc(300)).toBe(300);
    expect(clampToc(300.4)).toBe(300);
    expect(clampToc(300.6)).toBe(301);
  });

  it('默认值落在合法区间内', () => {
    expect(TOC_DEFAULT).toBeGreaterThanOrEqual(TOC_MIN);
    expect(TOC_DEFAULT).toBeLessThanOrEqual(TOC_MAX);
  });

  it('NaN / 非数字回退到默认宽度（localStorage 被手改坏时不炸）', () => {
    expect(clampToc(Number.NaN)).toBe(TOC_DEFAULT);
    expect(clampToc(Number.POSITIVE_INFINITY)).toBe(TOC_DEFAULT);
  });
});
