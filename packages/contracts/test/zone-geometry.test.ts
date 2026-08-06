/**
 * Detection-zone geometry (P-8 Phase 7).
 *
 * ⚠️ This is the **one** implementation of "is this subject inside that zone" in the platform — the
 * camera service validates with it, media evaluates with it on the frame path, and the console draws
 * with it. Three implementations would agree on every test anybody wrote and disagree on the case
 * that mattered, and the disagreement would surface as an incident that fired on one deployment and
 * not another.
 */
import { describe, expect, it } from 'vitest';
import {
  isEvaluableShape,
  pointInPolygon,
  rectanglePoints,
  validateZoneGeometry,
  ZONE_EVALUATION,
  ZoneShape,
  zoneAnchor,
  type Point2D,
} from '../src/index.js';

/** A unit square inset from the frame edges. */
const SQUARE: Point2D[] = rectanglePoints(0.2, 0.2, 0.4, 0.4);
/** An L, to catch anything that only works on convex shapes. */
const L_SHAPE: Point2D[] = [
  [0.1, 0.1],
  [0.5, 0.1],
  [0.5, 0.3],
  [0.3, 0.3],
  [0.3, 0.7],
  [0.1, 0.7],
];

describe('pointInPolygon', () => {
  it('accepts a point well inside a rectangle and rejects one well outside', () => {
    expect(pointInPolygon([0.4, 0.4], SQUARE)).toBe(true);
    expect(pointInPolygon([0.9, 0.9], SQUARE)).toBe(false);
  });

  it('handles a concave shape — the notch of an L is outside it', () => {
    expect(pointInPolygon([0.2, 0.5], L_SHAPE)).toBe(true);
    /* Inside the L's bounding box, outside the L itself. */
    expect(pointInPolygon([0.45, 0.5], L_SHAPE)).toBe(false);
  });

  /**
   * ⚠️ Boundary behaviour is deliberately unspecified — a tolerance constant in a geometry primitive
   * is a knob nobody can tune. What IS required is *stability*: a subject standing still on an edge
   * must get the same answer every frame, or their dwell shreds into nothing.
   */
  it('is stable on a boundary, whatever answer it gives', () => {
    const onEdge: Point2D = [0.2, 0.4];
    const answers = Array.from({ length: 50 }, () => pointInPolygon(onEdge, SQUARE));
    expect(new Set(answers).size).toBe(1);
  });

  it('is unaffected by winding direction', () => {
    const reversed = [...SQUARE].reverse();
    expect(pointInPolygon([0.4, 0.4], reversed)).toBe(true);
    expect(pointInPolygon([0.9, 0.9], reversed)).toBe(false);
  });
});

describe('zoneAnchor', () => {
  /**
   * ⚠️ The decision with a visible consequence. A standing person's box is about twice as tall as it
   * is wide, so its CENTRE drifts into a zone as soon as their shoulders overlap the line — while the
   * operator who drew the zone on the floor meant their feet.
   */
  it('is the bottom centre — the floor contact point, not the box centre', () => {
    expect(zoneAnchor([0.2, 0.1, 0.2, 0.4])).toEqual([0.30000000000000004, 0.5]);
  });

  it('distinguishes a person standing just outside a zone from one standing in it', () => {
    /* Zone occupies y ∈ [0.2, 0.6]. This person's feet are at y = 0.7 — outside. */
    const outside = zoneAnchor([0.35, 0.3, 0.1, 0.4]);
    expect(pointInPolygon(outside, SQUARE)).toBe(false);
    /* ⚠️ Their bbox CENTRE (y = 0.5) is inside — which is why the anchor matters. */
    expect(pointInPolygon([0.4, 0.5], SQUARE)).toBe(true);
  });
});

describe('validateZoneGeometry', () => {
  it('accepts a well-formed rectangle and polygon', () => {
    expect(validateZoneGeometry({ points: SQUARE }, 'area')).toEqual([]);
    expect(validateZoneGeometry({ points: L_SHAPE }, 'area')).toEqual([]);
  });

  it('refuses an area with fewer than three points', () => {
    const problems = validateZoneGeometry(
      {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      'area',
    );
    expect(problems.map((p) => p.code)).toContain('too-few-points');
  });

  it('refuses a point outside the normalised image plane', () => {
    const problems = validateZoneGeometry(
      {
        points: [
          [0, 0],
          [1.5, 0],
          [1, 1],
        ],
      },
      'area',
    );
    expect(problems.map((p) => p.code)).toContain('out-of-bounds');
  });

  it('refuses a polygon that encloses nothing', () => {
    const collinear: Point2D[] = [
      [0.1, 0.1],
      [0.3, 0.1],
      [0.5, 0.1],
    ];
    expect(validateZoneGeometry({ points: collinear }, 'area').map((p) => p.code)).toContain(
      'degenerate',
    );
  });

  /**
   * ⚠️ A bow tie has no unambiguous inside: even-odd says the lobes are outside, non-zero winding
   * says they are inside, and the canvas that drew it shaded whichever its renderer preferred. An
   * operator would see a filled shape and get an evaluator that disagreed with the picture.
   */
  it('refuses a self-intersecting polygon', () => {
    const bowTie: Point2D[] = [
      [0.1, 0.1],
      [0.5, 0.5],
      [0.5, 0.1],
      [0.1, 0.5],
    ];
    expect(validateZoneGeometry({ points: bowTie }, 'area').map((p) => p.code)).toContain(
      'self-intersecting',
    );
  });

  it('accepts a two-point line', () => {
    expect(
      validateZoneGeometry(
        {
          points: [
            [0.1, 0.1],
            [0.9, 0.9],
          ],
        },
        'line',
      ),
    ).toEqual([]);
  });
});

describe('the geometry abstraction (Architect rec 2)', () => {
  /**
   * The claim under test: *future Line, Path and Direction geometries fit without redesign*. It is
   * checked structurally — every shape is describable, and the table says which are evaluable and
   * exactly what each unimplemented one needs. A coverage table claiming everything works would be
   * discovered to be wrong by whoever tried it, under deadline.
   */
  it('describes every declared shape', () => {
    for (const shape of ZoneShape.options) {
      expect(ZONE_EVALUATION[shape]).toBeDefined();
      expect(ZONE_EVALUATION[shape].kind).toMatch(/^(area|line)$/);
    }
  });

  it('evaluates polygons and rectangles, and nothing else yet', () => {
    const evaluable = ZoneShape.options.filter(isEvaluableShape);
    expect(evaluable.sort()).toEqual(['polygon', 'rectangle']);
  });

  /** ⚠️ Every unimplemented shape must say what it needs — otherwise it is a stub with no plan. */
  it('names what each unimplemented shape is waiting for', () => {
    for (const shape of ZoneShape.options) {
      if (isEvaluableShape(shape)) continue;
      expect(ZONE_EVALUATION[shape].needs).toBeTruthy();
    }
  });
});

describe('rectanglePoints', () => {
  it('produces four corners clockwise from the top-left', () => {
    expect(rectanglePoints(0.1, 0.2, 0.3, 0.4)).toEqual([
      [0.1, 0.2],
      [0.4, 0.2],
      [0.4, 0.6000000000000001],
      [0.1, 0.6000000000000001],
    ]);
  });

  it('produces a rectangle the evaluator agrees is a rectangle', () => {
    const points = rectanglePoints(0.25, 0.25, 0.5, 0.5);
    expect(validateZoneGeometry({ points }, 'area')).toEqual([]);
    expect(pointInPolygon([0.5, 0.5], points)).toBe(true);
    expect(pointInPolygon([0.1, 0.1], points)).toBe(false);
  });
});
