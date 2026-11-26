import { useCallback, useLayoutEffect, useRef } from 'react';
import { screenToWorld, type Size, type Viewport } from './CanvasEngine';

export function interpolateViewport(from: Viewport, to: Viewport, progress: number): Viewport {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const ratio = Math.log(to.zoom / from.zoom);
  // Match translation to zoom so a point shared by both endpoint views stays anchored.
  const mix = Math.abs(ratio) < 1e-6 ? progress : Math.expm1(ratio * progress) / Math.expm1(ratio);
  return { x: from.x + (to.x - from.x) * mix, y: from.y + (to.y - from.y) * mix,
    zoom: from.zoom * Math.exp(ratio * progress) };
}

function duration(from: Viewport, to: Viewport, size: Size) {
  const center = { x: size.width / 2, y: size.height / 2 };
  const a = screenToWorld(from, center), b = screenToWorld(to, center);
  const distance = Math.hypot(a.x - b.x, a.y - b.y) * Math.min(from.zoom, to.zoom);
  const travel = distance / Math.max(320, Math.hypot(size.width, size.height));
  return 220 + Math.min(310, 82 * Math.abs(Math.log2(to.zoom / from.zoom)) + 150 * Math.sqrt(travel));
}

export function useCameraMotion(owner?: object | string) {
  const active = useRef<{ frame: number; target: Viewport } | null>(null);
  const cancel = useCallback(() => {
    if (!active.current) return false;
    cancelAnimationFrame(active.current.frame);
    active.current = null;
    return true;
  }, []);
  useLayoutEffect(() => () => { cancel(); }, [owner, cancel]);

  const animate = useCallback((from: Viewport, to: Viewport, size: Size, paint: (viewport: Viewport) => void, done?: () => void) => {
    cancel();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionDisabled = () => reduced.matches || document.documentElement.classList.contains('motion-off');
    if (motionDisabled() || (from.x === to.x && from.y === to.y && from.zoom === to.zoom)) {
      paint(to);
      done?.();
      return;
    }
    const start = performance.now(), ms = duration(from, to, size);
    const job = { frame: 0, target: to };
    function next(now: number) {
      if (active.current !== job) return;
      const t = motionDisabled() ? 1 : Math.min(1, Math.max(0, (now - start) / ms));
      const eased = t * t * t * (10 + t * (-15 + 6 * t));
      paint(interpolateViewport(from, to, eased));
      if (t < 1) job.frame = requestAnimationFrame(next);
      else { active.current = null; done?.(); }
    }
    active.current = job;
    job.frame = requestAnimationFrame(next);
  }, [cancel]);

  return { active, animate, cancel };
}
