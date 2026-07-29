import { useEffect, useState } from 'react';

function now(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

/** 24h wall clock (tabular so it doesn't jitter). Ticks once a second. */
export function LiveClock() {
  const [time, setTime] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setTime(now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="tabular hidden text-xs text-muted-foreground sm:inline"
      aria-label="Current time"
    >
      {time}
    </span>
  );
}
