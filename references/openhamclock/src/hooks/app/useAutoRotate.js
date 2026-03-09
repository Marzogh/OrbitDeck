/**
 * useAutoRotate — Reusable auto-rotation hook with localStorage persistence.
 *
 * Usage:
 *   const rotate = useAutoRotate('myPanel', { onTick, itemCount: 4 });
 *   // rotate.enabled, rotate.interval, rotate.toggle(), rotate.setInterval(seconds)
 *
 * @param {string} storageKey  Unique key for localStorage persistence (prefixed automatically)
 * @param {Object} opts
 * @param {Function} opts.onTick    Called each interval to advance to next item
 * @param {number}   opts.itemCount Total items to rotate through (rotation pauses if < 2)
 */
import { useState, useEffect, useCallback, useRef } from 'react';

const PREFIX = 'openhamclock_rotate_';
const DEFAULT_INTERVAL = 15; // seconds
const INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

function load(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {}
}

export function useAutoRotate(storageKey, { onTick, itemCount = 0 }) {
  const saved = load(storageKey);

  const [enabled, setEnabled] = useState(() => saved?.enabled ?? false);
  const [interval, setIntervalVal] = useState(() => saved?.interval ?? DEFAULT_INTERVAL);

  // Keep onTick ref stable so timer doesn't re-mount on every render
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  // Persist on change
  useEffect(() => {
    save(storageKey, { enabled, interval });
  }, [storageKey, enabled, interval]);

  // Timer
  useEffect(() => {
    if (!enabled || itemCount < 2) return;
    const id = setInterval(() => {
      onTickRef.current?.();
    }, interval * 1000);
    return () => clearInterval(id);
  }, [enabled, interval, itemCount]);

  const toggle = useCallback(() => setEnabled((v) => !v), []);

  const setInterval_ = useCallback((secs) => {
    const n = parseInt(secs, 10);
    if (Number.isFinite(n) && n >= 1) setIntervalVal(n);
  }, []);

  return {
    enabled,
    interval,
    toggle,
    setEnabled,
    setInterval: setInterval_,
    INTERVAL_OPTIONS,
  };
}

export { INTERVAL_OPTIONS };
export default useAutoRotate;
