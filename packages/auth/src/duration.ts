/** Parse a short duration string (`"900s"`, `"15m"`, `"7d"`, or a bare number of seconds) to seconds. */
export function parseDurationSeconds(input: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration: "${input}"`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
  return n * mult;
}
