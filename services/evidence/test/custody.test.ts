/**
 * Domain: chain-of-custody hash-chain integrity + tamper detection (pure, deterministic).
 */
import { describe, expect, it } from 'vitest';
import { newCustodyEntry, verifyChain, type CustodyDoc } from '../src/domain/custody.js';

function chainOf(...actions: CustodyDoc['action'][]): CustodyDoc[] {
  const out: CustodyDoc[] = [];
  let prevHash: string | null = null;
  actions.forEach((action, seq) => {
    const entry = newCustodyEntry({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      tenantId: 'tnt_a',
      evidenceId: 'evd_1',
      seq,
      action,
      actor: 'usr_1',
      at: new Date('2026-07-30T10:00:00.000Z'),
      prevHash,
    });
    out.push(entry);
    prevHash = entry.hash;
  });
  return out;
}

describe('chain of custody', () => {
  it('a well-formed chain verifies', () => {
    expect(verifyChain(chainOf('created', 'accessed', 'metadata-updated'))).toBe(true);
  });

  it('genesis entry has seq 0 and null prevHash', () => {
    const [genesis] = chainOf('created');
    expect(genesis!.seq).toBe(0);
    expect(genesis!.prevHash).toBeNull();
  });

  it('detects a tampered field (actor changed without re-hashing)', () => {
    const chain = chainOf('created', 'accessed');
    chain[1]!.actor = 'attacker'; // tamper: content no longer matches the sealed hash
    expect(verifyChain(chain)).toBe(false);
  });

  it('detects a broken link (prevHash rewired)', () => {
    const chain = chainOf('created', 'accessed', 'expired');
    chain[2]!.prevHash = chain[0]!.hash; // skip an entry
    expect(verifyChain(chain)).toBe(false);
  });

  it('detects reordering (seq mismatch)', () => {
    const chain = chainOf('created', 'accessed');
    [chain[0], chain[1]] = [chain[1]!, chain[0]!];
    expect(verifyChain(chain)).toBe(false);
  });
});
