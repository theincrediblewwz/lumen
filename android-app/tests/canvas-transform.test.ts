import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateFocalZoom,
  MAX_CANVAS_SCALE,
  MIN_CANVAS_SCALE,
  shouldApplyPinchUpdate,
} from '../components/canvas-transform';

function boardPointAtFocal(
  focalX: number,
  focalY: number,
  translateX: number,
  translateY: number,
  scale: number,
) {
  return { x: (focalX - translateX) / scale, y: (focalY - translateY) / scale };
}

test('keeps the same board point under a stationary two-finger focal point', () => {
  const start = { x: 420, y: 680 };
  const before = boardPointAtFocal(start.x, start.y, -90, 35, 0.55);
  const next = calculateFocalZoom({
    startTranslateX: -90,
    startTranslateY: 35,
    startScale: 0.55,
    startFocalX: start.x,
    startFocalY: start.y,
    currentFocalX: start.x,
    currentFocalY: start.y,
    scaleFactor: 1.7,
  });
  const after = boardPointAtFocal(start.x, start.y, next.translateX, next.translateY, next.scale);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test('tracks a moving focal point while pinching and supports zooming out', () => {
  const before = boardPointAtFocal(240, 360, -120, 20, 0.8);
  const next = calculateFocalZoom({
    startTranslateX: -120,
    startTranslateY: 20,
    startScale: 0.8,
    startFocalX: 240,
    startFocalY: 360,
    currentFocalX: 300,
    currentFocalY: 410,
    scaleFactor: 0.7,
  });
  const after = boardPointAtFocal(300, 410, next.translateX, next.translateY, next.scale);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test('preserves the focal invariant when scale is clamped', () => {
  for (const [factor, expectedScale] of [[0.01, MIN_CANVAS_SCALE], [99, MAX_CANVAS_SCALE]] as const) {
    const before = boardPointAtFocal(180, 520, -60, 70, 0.6);
    const next = calculateFocalZoom({
      startTranslateX: -60,
      startTranslateY: 70,
      startScale: 0.6,
      startFocalX: 180,
      startFocalY: 520,
      currentFocalX: 180,
      currentFocalY: 520,
      scaleFactor: factor,
    });
    const after = boardPointAtFocal(180, 520, next.translateX, next.translateY, next.scale);
    assert.equal(next.scale, expectedScale);
    assert.ok(Math.abs(before.x - after.x) < 1e-9);
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  }
});

test('ignores the one-pointer tail emitted while a pinch is ending', () => {
  assert.equal(shouldApplyPinchUpdate(2), true);
  assert.equal(shouldApplyPinchUpdate(1), false);
  assert.equal(shouldApplyPinchUpdate(3), false);
});
