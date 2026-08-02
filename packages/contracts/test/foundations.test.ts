/**
 * The foundation register is **governance metadata** (P-2.3, Architect rec 1).
 *
 * These tests exist to keep it that way. The register must stay a flat, inert list of declarations
 * that documents point at — the moment it grows a rule, a threshold or a capability flag, something
 * will start branching on it and the architecture freeze will have become a runtime concern.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDATIONS, foundation } from '../src/common/foundations.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

describe('the foundation register', () => {
  it('declares every frozen foundation as additive-only', () => {
    expect(FOUNDATIONS.length).toBeGreaterThan(0);
    for (const entry of FOUNDATIONS) {
      expect(entry.status).toBe('frozen');
      // A frozen foundation that could evolve any other way is not frozen.
      expect(entry.evolution).toBe('additive-only');
      expect(entry.version).toMatch(/^\d+\.\d+$/);
      expect(Number.isNaN(Date.parse(entry.frozenAt))).toBe(false);
    }
  });

  it('points every entry at a record that actually exists', () => {
    // A freeze whose authority is a broken link is a freeze nobody can check.
    for (const entry of FOUNDATIONS) {
      expect(() => readFileSync(join(repoRoot, entry.record), 'utf8')).not.toThrow();
    }
  });

  it('names the Camera Foundation at v1.0', () => {
    expect(foundation('Camera Foundation')).toMatchObject({
      version: '1.0',
      status: 'frozen',
      evolution: 'additive-only',
      frozenAt: '2026-08-02',
    });
  });

  it('carries no field that could be branched on', () => {
    // Names, versions, dates and a doc path. No flags, no thresholds, no capability lists — because
    // the first `if (foundation.supportsX)` is the end of "governance metadata only".
    const allowed = new Set(['name', 'version', 'status', 'evolution', 'frozenAt', 'record']);
    for (const entry of FOUNDATIONS) {
      expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([]);
      expect(Object.values(entry).every((value) => typeof value === 'string')).toBe(true);
    }
  });
});
