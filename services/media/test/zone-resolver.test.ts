/**
 * Zone resolution on the frame path (P-8 Phase 7).
 *
 * This is the one place in the platform where a detection acquires a zone, and it runs on the process
 * that writes recordings. The tests below are about what an operator would notice, plus the two
 * properties that make it safe to run there: it never throws, and it never allocates per zone.
 */
import { describe, expect, it } from 'vitest';
import { rectanglePoints, type PlanZone } from '@vip/contracts';
import { resolveZones, ZONE_ATTRIBUTE, zonesOf } from '../src/application/zone-resolver.js';

const queue: PlanZone = {
  zoneId: 'zn-queue',
  name: 'Checkout Queue',
  kind: 'area',
  points: rectanglePoints(0.2, 0.5, 0.4, 0.4),
  version: 1,
};
const aisle: PlanZone = {
  zoneId: 'zn-aisle',
  name: 'Aisle 3',
  kind: 'area',
  points: rectanglePoints(0.3, 0.6, 0.4, 0.3),
  version: 2,
};

/** A standing person: box twice as tall as wide, feet at `y + h`. */
const person = (
  x: number,
  feetY: number,
): { bbox: [number, number, number, number]; attributes: Record<string, unknown> } => ({
  bbox: [x - 0.05, feetY - 0.3, 0.1, 0.3],
  attributes: {},
});

describe('resolveZones', () => {
  it('stamps the zone a subject is standing in', () => {
    const d = person(0.4, 0.7);
    const result = resolveZones([d], [queue]);
    expect(result).toEqual({ tested: 1, inside: 1 });
    expect(zonesOf(d.attributes)).toEqual(['zn-queue']);
  });

  /**
   * ⚠️ Absence, not an empty array. The events normalizer branches on presence, and an empty array
   * would be a third state meaning the same thing — which is how two services end up disagreeing
   * about what "no zones" looks like.
   */
  it('leaves no attribute at all on a subject inside nothing', () => {
    const d = person(0.9, 0.2);
    expect(resolveZones([d], [queue])).toEqual({ tested: 1, inside: 0 });
    expect(d.attributes[ZONE_ATTRIBUTE]).toBeUndefined();
  });

  /** ⚠️ `inside` counts MEMBERSHIPS — it is the number that predicts the event fan-out. */
  it('stamps every overlapping zone and counts each membership', () => {
    const d = person(0.45, 0.75);
    const result = resolveZones([d], [queue, aisle]);
    expect(result).toEqual({ tested: 1, inside: 2 });
    expect(zonesOf(d.attributes).sort()).toEqual(['zn-aisle', 'zn-queue']);
  });

  /**
   * ⚠️ A `line` zone has no interior, so membership is undefined for it and it is skipped rather than
   * answered. Feeding a polyline to a point-in-polygon test returns a confident answer meaning
   * nothing.
   */
  it('skips line zones rather than guessing at their interior', () => {
    const line: PlanZone = {
      zoneId: 'zn-door',
      name: 'Doorway',
      kind: 'line',
      points: [
        [0.1, 0.5],
        [0.9, 0.5],
      ],
      version: 1,
    };
    const d = person(0.4, 0.7);
    expect(resolveZones([d], [line])).toEqual({ tested: 1, inside: 0 });
    expect(d.attributes[ZONE_ATTRIBUTE]).toBeUndefined();
  });

  it('does nothing, cheaply, when the camera has no zones', () => {
    const d = person(0.4, 0.7);
    expect(resolveZones([d], [])).toEqual({ tested: 0, inside: 0 });
    expect(d.attributes[ZONE_ATTRIBUTE]).toBeUndefined();
  });

  /**
   * ⚠️ The floor contact point, not the box centre. This person's shoulders overlap the zone and
   * their feet do not — and the operator drew the zone on the floor.
   */
  it('uses the feet, so a person standing just outside is outside', () => {
    /*
     * A zone on the floor between y 0.2 and 0.5, and a person standing BELOW it whose upper body
     * overlaps it. Their box centre (0.4, 0.45) is inside the zone; their feet (0.4, 0.65) are not.
     * ⚠️ A centre-based resolver would put this person in the zone, and the operator who drew it on
     * the floor would disagree — which is the entire reason `zoneAnchor` exists.
     */
    const shelf: PlanZone = {
      zoneId: 'zn-shelf',
      name: 'Shelf frontage',
      kind: 'area',
      points: rectanglePoints(0.2, 0.2, 0.4, 0.3),
      version: 1,
    };
    const bbox: [number, number, number, number] = [0.35, 0.25, 0.1, 0.4];
    const standingBelow = { bbox, attributes: {} };
    expect(resolveZones([standingBelow], [shelf]).inside).toBe(0);

    /* The same person, moved up so their FEET are in the zone, is inside it. */
    const standingIn = {
      bbox: [0.35, 0.1, 0.1, 0.3] as [number, number, number, number],
      attributes: {},
    };
    expect(resolveZones([standingIn], [shelf]).inside).toBe(1);
  });
});

describe('zonesOf', () => {
  /**
   * ⚠️ Defensive because the value crossed a service boundary and a broker into an open map. A
   * malformed member becoming a `zoneId` would become an incident's primary key.
   */
  it('ignores anything that is not an array of non-empty strings', () => {
    expect(zonesOf(undefined)).toEqual([]);
    expect(zonesOf({})).toEqual([]);
    expect(zonesOf({ [ZONE_ATTRIBUTE]: 'zn-1' })).toEqual([]);
    expect(zonesOf({ [ZONE_ATTRIBUTE]: [1, null, '', 'zn-1'] })).toEqual(['zn-1']);
  });
});
