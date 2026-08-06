/**
 * Detection-zone construction and versioning in the camera context (P-8 Phase 7).
 *
 * ⚠️ The version history is the load-bearing part. An incident raised in March names a zone and a
 * version, and its detail page must draw **that** polygon over **that** footage — otherwise it draws
 * today's, confidently, and is wrong in a way that looks exactly like being right.
 */
import { describe, expect, it } from 'vitest';
import { rectanglePoints, type CreateDetectionZoneInput } from '@vip/contracts';
import { createZone, updateZone, type ZoneDoc } from '../src/domain/zone.js';

const NOW = new Date('2026-08-06T10:00:00.000Z');
const deps = { now: () => NOW, newId: () => 'zn-fixed' };

const input = (over: Partial<CreateDetectionZoneInput> = {}): CreateDetectionZoneInput => ({
  cameraId: 'cam-1',
  name: 'Checkout Queue',
  kind: 'area',
  shape: 'rectangle',
  geometry: { points: rectanglePoints(0.2, 0.5, 0.4, 0.4) },
  enabled: true,
  attributes: {},
  ...over,
});

const ok = (result: ReturnType<typeof createZone>) => {
  if ('refusal' in result) throw new Error(`unexpected refusal: ${JSON.stringify(result.refusal)}`);
  return result;
};

const refusal = (result: ReturnType<typeof createZone>) => {
  if (!('refusal' in result)) throw new Error('expected a refusal');
  return result.refusal;
};

describe('creating a zone', () => {
  it('starts at version 1 with a created snapshot', () => {
    const { doc, version } = ok(createZone('t-1', input(), [], deps));
    expect(doc.version).toBe(1);
    expect(version.changeKind).toBe('created');
    expect(version.snapshot.version).toBe(1);
    expect(doc._id).toBe('t-1:zn-fixed');
  });

  it('refuses a rectangle that is not four points', () => {
    const bad = input({
      geometry: {
        points: [
          [0.1, 0.1],
          [0.5, 0.1],
          [0.5, 0.5],
        ],
      },
    });
    expect(refusal(createZone('t-1', bad, [], deps)).kind).toBe('geometry');
  });

  /** ⚠️ A polygon that crosses itself has no unambiguous inside — see the geometry tests. */
  it('refuses a self-intersecting polygon', () => {
    const bowTie = input({
      shape: 'polygon',
      geometry: {
        points: [
          [0.1, 0.1],
          [0.5, 0.5],
          [0.5, 0.1],
          [0.1, 0.5],
        ],
      },
    });
    expect(refusal(createZone('t-1', bowTie, [], deps)).kind).toBe('geometry');
  });

  /**
   * ⚠️ Refused at creation, not skipped at evaluation. A `path` zone the platform cannot evaluate
   * would be configuration that silently does nothing — drawn, saved, listed, and never firing.
   */
  it('refuses a shape it can describe but not evaluate', () => {
    const r = refusal(createZone('t-1', input({ shape: 'path', kind: 'line' }), [], deps));
    expect(r.kind).toBe('shape-not-evaluable');
    if (r.kind === 'shape-not-evaluable') expect(r.needs).toBeTruthy();
  });

  it('refuses a kind that contradicts the shape', () => {
    expect(refusal(createZone('t-1', input({ kind: 'line' }), [], deps)).kind).toBe('geometry');
  });

  /** Two zones called "Checkout" on one camera produce incidents nobody can tell apart. */
  it('refuses a duplicate name on the same camera, case-insensitively', () => {
    const existing = ok(createZone('t-1', input(), [], deps)).doc;
    const clash = createZone('t-1', input({ name: '  checkout queue ' }), [existing], deps);
    expect(refusal(clash).kind).toBe('duplicate-name');
  });

  it('allows the same name on a different camera', () => {
    const onCam1 = ok(createZone('t-1', input(), [], deps)).doc;
    /* `existingOnCamera` is the caller's per-camera query, so a zone on cam-2 sees an empty list. */
    expect('refusal' in createZone('t-1', input({ cameraId: 'cam-2' }), [], deps)).toBe(false);
    expect(onCam1.cameraId).toBe('cam-1');
  });

  it('refuses more zones than a camera may hold', () => {
    const full = Array.from({ length: 32 }, (_, i) => ({ name: `z${i}` }) as ZoneDoc);
    expect(refusal(createZone('t-1', input(), full, deps)).kind).toBe('too-many-zones');
  });
});

describe('updating a zone', () => {
  const existing = () => ok(createZone('t-1', input(), [], deps)).doc;

  it('bumps the version and records the change kind', () => {
    const moved = updateZone(
      existing(),
      { geometry: { points: rectanglePoints(0.1, 0.1, 0.5, 0.5) } },
      [],
      deps,
    );
    const { doc, version } = ok(moved);
    expect(doc.version).toBe(2);
    expect(version.changeKind).toBe('geometry-changed');
  });

  it('distinguishes a rename from a move from a switch-off', () => {
    expect(ok(updateZone(existing(), { name: 'Till 2' }, [], deps)).version.changeKind).toBe(
      'renamed',
    );
    expect(ok(updateZone(existing(), { enabled: false }, [], deps)).version.changeKind).toBe(
      'disabled',
    );
    expect(ok(updateZone(existing(), { enabled: true }, [], deps)).version.changeKind).not.toBe(
      'disabled',
    );
  });

  /**
   * ⚠️ Each version's snapshot must hold **that version's** geometry. If the snapshot were taken
   * before the patch, every historical incident would resolve to the geometry of the edit *before*
   * the one that produced it.
   */
  it('snapshots the geometry as it is AFTER the change', () => {
    const points = rectanglePoints(0.1, 0.1, 0.2, 0.2);
    const { version } = ok(updateZone(existing(), { geometry: { points } }, [], deps));
    expect(version.snapshot.geometry.points).toEqual(points);
    expect(version.version).toBe(2);
  });

  it('refuses an update that would make the geometry invalid', () => {
    const bad = updateZone(
      existing(),
      {
        geometry: {
          points: [
            [0.1, 0.1],
            [0.9, 0.9],
          ],
        },
      },
      [],
      deps,
    );
    expect(refusal(bad).kind).toBe('geometry');
  });

  it('refuses a rename that collides with a sibling', () => {
    const a = existing();
    const b: ZoneDoc = { ...a, zoneId: 'zn-other', name: 'Aisle 3' };
    expect(refusal(updateZone(b, { name: 'Checkout Queue' }, [a, b], deps)).kind).toBe(
      'duplicate-name',
    );
  });

  it('lets a zone keep its own name', () => {
    const a = existing();
    expect('refusal' in updateZone(a, { name: 'Checkout Queue' }, [a], deps)).toBe(false);
  });
});
