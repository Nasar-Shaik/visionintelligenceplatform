/**
 * The bound on drawn marks (P-5.6).
 *
 * ⚠️ The requirement was "verify thousands of bookmarks". The check that matters is not that it
 * *works* with thousands — it is that the number of elements the renderer is asked to build does
 * not grow with the collection. These tests assert the bound, not the wall-clock time, because a
 * timing assertion on CI hardware is a flake and a count is a fact.
 */
import { describe, expect, it } from 'vitest';
import { MAX_DRAWN_MARKS, clusterMarks } from './marks';

const START = Date.parse('2026-08-03T00:00:00.000Z');
const DAY = 86_400;

const bookmarksEvery = (seconds: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `bm-${index}`,
    at: new Date(START + index * seconds * 1000).toISOString(),
    label: `Mark ${index}`,
  }));

describe('culling to the visible window', () => {
  it('drops everything outside the window before an element exists', () => {
    const marks = bookmarksEvery(600, 144); // one every ten minutes across a day
    /* A ten-minute window at the start of the day should keep about two of them. */
    const drawn = clusterMarks(marks, START, 0, 600);
    expect(drawn.length).toBeLessThanOrEqual(2);
  });

  it('keeps marks that are inside it', () => {
    const marks = bookmarksEvery(60, 10);
    const drawn = clusterMarks(marks, START, 0, 600);
    expect(drawn.length).toBe(10);
    expect(drawn[0]?.label).toBe('Mark 0');
  });

  it('⚠️ an unparseable timestamp is dropped, never pinned to the start of the recording', () => {
    const drawn = clusterMarks([{ id: 'bad', at: 'whenever', label: 'Broken' }], START, 0, DAY);
    expect(drawn).toEqual([]);
  });
});

describe('⚠️ the count drawn is bounded by the track, not by the collection', () => {
  it('collapses five thousand bookmarks over a day into a legible number of pins', () => {
    const marks = bookmarksEvery(17, 5000);
    const drawn = clusterMarks(marks, START, 0, DAY);
    expect(marks.length).toBe(5000);
    expect(drawn.length).toBeLessThanOrEqual(MAX_DRAWN_MARKS);
    /* And nothing is silently lost — the counts still add up to what is in the window. */
    const total = drawn.reduce((sum, cluster) => sum + cluster.count, 0);
    const inWindow = marks.filter((m) => Date.parse(m.at) - START <= DAY * 1000).length;
    expect(total).toBe(inWindow);
  });

  it('holds the bound for ten thousand marks in one second of a day-long timeline', () => {
    const marks = Array.from({ length: 10_000 }, (_, index) => ({
      id: `bm-${index}`,
      at: new Date(START + 3600_000 + index).toISOString(),
      label: `Mark ${index}`,
    }));
    const drawn = clusterMarks(marks, START, 0, DAY);
    /* All ten thousand share a pixel column, so they are one pin that says so. */
    expect(drawn.length).toBe(1);
    expect(drawn[0]?.count).toBe(10_000);
  });

  it('⚠️ zooming in separates what clustering collapsed', () => {
    const marks = bookmarksEvery(60, 20); // one a minute for twenty minutes
    const dayView = clusterMarks(marks, START, 0, DAY);
    const tenMinuteView = clusterMarks(marks, START, 0, 600);
    expect(dayView.length).toBeLessThan(tenMinuteView.length);
    /* Offsets 0…600s inclusive — eleven of the twenty fall inside a ten-minute window. */
    expect(tenMinuteView.length).toBe(11);
  });
});

describe('a cluster represents its earliest member', () => {
  it('seeks to the first moment in the group, and names it', () => {
    const marks = [
      { id: 'b', at: new Date(START + 5000).toISOString(), label: 'Second' },
      { id: 'a', at: new Date(START + 1000).toISOString(), label: 'First' },
    ];
    const drawn = clusterMarks(marks, START, 0, DAY);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.label).toBe('First');
    expect(drawn[0]?.offsetSeconds).toBe(1);
    expect(drawn[0]?.count).toBe(2);
  });

  it('⚠️ keys on the representative id, so React does not reuse one bookmark’s tooltip for another', () => {
    const drawn = clusterMarks(bookmarksEvery(60, 3), START, 0, 600);
    expect(drawn.map((c) => c.key)).toEqual(['bm-0', 'bm-1', 'bm-2']);
  });
});

describe('degenerate windows', () => {
  it('returns nothing rather than dividing by zero', () => {
    expect(clusterMarks(bookmarksEvery(60, 5), START, 0, 0)).toEqual([]);
    expect(clusterMarks([], START, 0, DAY)).toEqual([]);
  });
});
