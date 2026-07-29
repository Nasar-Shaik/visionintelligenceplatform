/** Presentation formatters — pure, locale-aware, no side effects. */

/** Compact relative time ("just now", "3m", "2h", "4d") for dense operator UIs. */
export function timeAgo(input: string | number | Date, now: Date = new Date()): string {
  const then = input instanceof Date ? input : new Date(input);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return then.toLocaleDateString();
}

/** Absolute timestamp for tooltips/detail (locale, 24h, with seconds). */
export function formatTimestamp(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Shorten a correlation/UUID for dense display, full value kept for the title attr. */
export function shortId(id: string, head = 8): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`;
}
