/**
 * Hierarchy scale — the **asymptotic** assertion (nightly only).
 *
 * ⚠️ **Excluded from `pnpm test` on purpose**, by the `*.nightly.test.ts` convention.
 *
 * This compares two wall-clock timings to assert an algorithmic property. The unit gate runs 28
 * suites in parallel, and a ratio between two timings taken under unbounded CPU contention cannot be
 * made trustworthy by sampling harder — three versions of it were flaky in the gate (single-sample,
 * best-of-five, and a self-calibrating baseline), each less often than the last and none reliably.
 *
 * Per the execution policy of 2026-08-06, a verification whose reliability depends on a quiet machine
 * belongs to the Nightly Framework rather than to the working day. It runs there, on a machine doing
 * nothing else, where the instrument works.
 *
 * ⚠️ **The assertion is not weakened by moving.** An O(n²) implementation is quadratic in its fastest
 * run too, so this cannot be made to pass by getting lucky. What changed is where it is asked, not
 * what it asks. The gate keeps the correctness half — the tree is built right at enterprise scale,
 * inside a ceiling only an algorithmic regression reaches.
 */
import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/domain/hierarchy.js';
import type { OrgNodeDoc } from '../src/domain/tenant.js';
import type { OrgNodeType } from '@vip/contracts';

const AT = '2026-08-02T00:00:00.000Z';

function node(id: string, type: OrgNodeType, parentId: string | null, path: string[]): OrgNodeDoc {
  return {
    _id: id,
    tenantId: 'tnt_1',
    parentId,
    type,
    name: id,
    path,
    depth: path.length,
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  };
}

/** 1 org · `branches` branches · `zonesPer` zones each. */
function estate(branches: number, zonesPer: number): OrgNodeDoc[] {
  const docs: OrgNodeDoc[] = [node('org', 'org', null, [])];
  for (let b = 0; b < branches; b += 1) {
    const branch = `b${b}`;
    docs.push(node(branch, 'branch', 'org', ['org']));
    for (let z = 0; z < zonesPer; z += 1) {
      docs.push(node(`${branch}_z${z}`, 'zone', branch, ['org', branch]));
    }
  }
  return docs;
}

describe('enterprise scale — asymptotics (nightly)', () => {
  it('scales linearly rather than quadratically', () => {
    /**
     * Best of several runs per size.
     *
     * ⚠️ Even on a quiet machine one sample can land in a GC pause or a scheduler slice. Taking the
     * fastest removes that without weakening anything: quadratic is quadratic at its best too.
     */
    const best = (docs: OrgNodeDoc[]) => {
      let fastest = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        buildTree(docs);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    // Warm the JIT so the first measurement is not the compiler.
    best(estate(100, 10));

    /**
     * The baseline must be large enough to dominate timer resolution and jitter.
     *
     * ⚠️ 5 000 nodes builds in **under a millisecond**, and comparing two sub-millisecond readings is
     * comparing noise. Growing until the baseline is measurable is what makes the ratio mean
     * something — and it is self-calibrating, so a fast machine does less work and a slow one is not
     * penalised for being slow.
     */
    const MEASURABLE_MS = 5;
    let branches = 200; // ~5k nodes
    let small = best(estate(branches, 25));
    /* ⚠️ Bounded: an unbounded loop here would hang rather than fail. */
    while (small < MEASURABLE_MS && branches < 6_400) {
      branches *= 2;
      small = best(estate(branches, 25));
    }

    const large = best(estate(branches * 4, 25));

    /*
     * Linear would be ~4×; quadratic would be ~16×. The bound is 10× — well above the measurement's
     * own spread on an idle machine, and well below what an O(n²) regression produces.
     */
    expect(large).toBeLessThan(small * 10);
  });
});
