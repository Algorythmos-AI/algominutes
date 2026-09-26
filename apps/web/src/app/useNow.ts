import { useEffect, useState } from 'react';

/** The current time, updated every `everyMs`: render stays pure, and "taking longer than usual" still appears on its own. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
