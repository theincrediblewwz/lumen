import { expect, it } from 'vitest';
import { aiWindowSize } from './aiWindow';
it('opens landscape within the current monitor work area', () => {
  expect(aiWindowSize(1440, 900)).toEqual({ width: 1040, height: 720, minWidth: 520, minHeight: 420 });
  const small = aiWindowSize(800, 600);
  expect(small.width).toBeLessThan(800);
  expect(small.height).toBeLessThan(600);
  expect(small.width).toBeGreaterThan(small.height);
});
