import { describe, expect, it } from 'vitest';
import { severityRank, severityTokens, SEVERITY_ORDER } from './severity';
import { shortId, timeAgo } from './format';

describe('severity tokens', () => {
  it('maps every EventPriority to a token + label', () => {
    for (const priority of SEVERITY_ORDER) {
      const { token, label } = severityTokens(priority);
      expect(token).toMatch(/^sev-/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('ranks critical above info', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('info'));
  });
});

describe('format helpers', () => {
  it('renders compact relative time', () => {
    const now = new Date('2026-07-27T12:00:00Z');
    expect(timeAgo(new Date('2026-07-27T11:58:00Z'), now)).toBe('2m');
    expect(timeAgo(new Date('2026-07-27T11:59:59Z'), now)).toBe('just now');
  });

  it('shortens long ids and leaves short ids intact', () => {
    expect(shortId('abcdefghijkl', 8)).toBe('abcdefgh…');
    expect(shortId('abc', 8)).toBe('abc');
  });
});
