import { useRef, useSyncExternalStore, type TouchEvent } from 'react';

// Phone / touch support helpers: no hover and no right-click on phones, so the UI keys off these.

const mq = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q) : null);
const touchMQ = mq('(hover: none) and (pointer: coarse)');
const forced = (() => { try { return new URLSearchParams(location.search).get('touch') === '1'; } catch { return false; } })();

/** True on devices without hover (phones, tablets). `?touch=1` forces it for testing on a desktop. */
export function isTouch(): boolean {
  return forced || !!touchMQ?.matches;
}

function subscribe(queries: (MediaQueryList | null)[]) {
  return (cb: () => void) => {
    queries.forEach((m) => m?.addEventListener?.('change', cb));
    return () => queries.forEach((m) => m?.removeEventListener?.('change', cb));
  };
}

const subTouch = subscribe([touchMQ]);
export function useTouch(): boolean {
  return useSyncExternalStore(subTouch, isTouch);
}

export type Layout = 'desktop' | 'portrait' | 'landscape';
/** Same breakpoints as mobile.css. */
const portraitMQ = mq('(orientation: portrait) and (max-width: 820px)');
const landscapeMQ = mq('(orientation: landscape) and (max-height: 500px)');
const subLayout = subscribe([portraitMQ, landscapeMQ]);
const layoutNow = (): Layout => (portraitMQ?.matches ? 'portrait' : landscapeMQ?.matches ? 'landscape' : 'desktop');
/** 'portrait' / 'landscape' = phone-sized viewport in that orientation. */
export function useLayout(): Layout {
  return useSyncExternalStore(subLayout, layoutNow);
}

/** Long-press (default 500ms) detection for touch. `consumed()` is true once for the click that ends a long press. */
export function useLongPress(onLong: (x: number, y: number) => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; };
  return {
    props: {
      onTouchStart: (e: TouchEvent) => {
        fired.current = false;
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
        clear();
        timer.current = setTimeout(() => { fired.current = true; onLong(start.current.x, start.current.y); }, ms);
      },
      onTouchMove: (e: TouchEvent) => {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) clear();
      },
      onTouchEnd: (e: TouchEvent) => { clear(); if (fired.current && e.cancelable) e.preventDefault(); },
      onTouchCancel: clear,
    },
    consumed: () => { if (fired.current) { fired.current = false; return true; } return false; },
  };
}
