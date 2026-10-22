"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data now and again every `everyMs` (a function of the latest data, so callers can poll fast while
 * something is in progress and slowly otherwise). Keeps the last good data when a refresh fails.
 */
export function usePoll<T>(load: () => Promise<T>, everyMs: (data: T | null) => number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  const everyRef = useRef(everyMs);
  useEffect(() => {
    loadRef.current = load;
    everyRef.current = everyMs;
  });
  const refresh = useCallback(async () => {
    try {
      const d = await loadRef.current();
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await refresh();
      if (stop) return;
      timer = setTimeout(tick, everyRef.current(d));
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  return { data, error, loading, refresh };
}
