import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { motionDisabled } from '../canvas/cameraMotion';

export function useCanvasNavigation(workspace: RefObject<HTMLDivElement>) {
  const active = useRef<Animation>();
  useLayoutEffect(() => () => active.current?.cancel(), []);

  return useCallback(async (commit: () => void) => {
    const host = workspace.current;
    const outgoing = host?.firstElementChild;
    if (!host || !(outgoing instanceof HTMLElement) || motionDisabled() || document.hidden) {
      active.current?.cancel();
      commit();
      return;
    }

    // Keep the live scene usable as soon as it mounts, including pointer capture for pan and drag.
    const from = Number(getComputedStyle(outgoing).opacity);
    active.current?.cancel();
    host.dataset.canvasNavigation = 'leaving';
    outgoing.inert = true;
    const leave = outgoing.animate([{ opacity: from }, { opacity: 0 }], { duration: 115 * from, easing: 'ease-in', fill: 'both' });
    active.current = leave;
    try {
      await leave.finished.catch(() => {});
      if (workspace.current !== host) return;
      flushSync(commit);
    } finally {
      leave.cancel();
      outgoing.inert = false;
      active.current = undefined;
      delete host.dataset.canvasNavigation;
    }
    const incoming = host.firstElementChild;
    if (!incoming || motionDisabled()) return;
    host.dataset.canvasNavigation = 'entering';
    const enter = incoming.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 205, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'backwards',
    });
    active.current = enter;
    const clear = () => {
      if (active.current !== enter) return;
      active.current = undefined;
      delete host.dataset.canvasNavigation;
    };
    void enter.finished.then(clear, clear);
  }, [workspace]);
}
