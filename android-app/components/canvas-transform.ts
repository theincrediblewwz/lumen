export const MIN_CANVAS_SCALE = 0.28;
export const MAX_CANVAS_SCALE = 1.35;

export type FocalZoomInput = {
  startTranslateX: number;
  startTranslateY: number;
  startScale: number;
  startFocalX: number;
  startFocalY: number;
  currentFocalX: number;
  currentFocalY: number;
  scaleFactor: number;
};

export function clampCanvasScale(value: number) {
  'worklet';
  return Math.max(MIN_CANVAS_SCALE, Math.min(MAX_CANVAS_SCALE, value));
}

export function shouldApplyPinchUpdate(numberOfPointers: number) {
  'worklet';
  return numberOfPointers === 2;
}

export function calculateFocalZoom(input: FocalZoomInput) {
  'worklet';
  const startScale = clampCanvasScale(input.startScale);
  const nextScale = clampCanvasScale(startScale * input.scaleFactor);
  const anchorX = (input.startFocalX - input.startTranslateX) / startScale;
  const anchorY = (input.startFocalY - input.startTranslateY) / startScale;
  return {
    scale: nextScale,
    translateX: input.currentFocalX - anchorX * nextScale,
    translateY: input.currentFocalY - anchorY * nextScale,
  };
}
