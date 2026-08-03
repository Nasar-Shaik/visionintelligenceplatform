/**
 * What playback remembers (P-5.6).
 *
 * ⚠️ The scope is the assertion: survives a refresh, dies with the tab, never reaches the server,
 * and never grows without bound across a shift of opening clips.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_CAPACITY, forgetAll, recall, remember, restorablePosition } from './session-memory';

beforeEach(() => forgetAll());

describe('remembering a clip', () => {
  it('recalls what was stored', () => {
    remember('clip-1', { positionSeconds: 42, rate: 0.5, volume: 0.3, muted: false });
    expect(recall('clip-1')).toEqual({
      positionSeconds: 42,
      rate: 0.5,
      volume: 0.3,
      muted: false,
    });
  });

  it('merges rather than replaces, so setting the volume does not forget the position', () => {
    remember('clip-1', { positionSeconds: 42 });
    remember('clip-1', { volume: 0.2 });
    expect(recall('clip-1')).toEqual({ positionSeconds: 42, volume: 0.2 });
  });

  it('knows nothing about a clip it has not seen', () => {
    expect(recall('never-opened')).toBeUndefined();
  });

  it('⚠️ lives in sessionStorage, so it dies with the tab and is never sent anywhere', () => {
    remember('clip-1', { positionSeconds: 42 });
    expect(sessionStorage.getItem('vip.playback.memory.v1')).toContain('clip-1');
    expect(localStorage.getItem('vip.playback.memory.v1')).toBeNull();
  });
});

describe('⚠️ a shift of opening clips does not grow without bound', () => {
  it('evicts the oldest past capacity', () => {
    for (let index = 0; index < MEMORY_CAPACITY + 25; index += 1) {
      remember(`clip-${index}`, { positionSeconds: index });
    }
    /* The first 25 aged out; the most recent survive. */
    expect(recall('clip-0')).toBeUndefined();
    expect(recall('clip-24')).toBeUndefined();
    expect(recall('clip-25')).toBeDefined();
    expect(recall(`clip-${MEMORY_CAPACITY + 24}`)).toBeDefined();
  });

  it('re-touching a clip makes it recent again', () => {
    remember('old', { positionSeconds: 1 });
    for (let index = 0; index < MEMORY_CAPACITY - 1; index += 1) {
      remember(`filler-${index}`, { positionSeconds: index });
    }
    remember('old', { positionSeconds: 2 });
    remember('newest', { positionSeconds: 3 });
    expect(recall('old')?.positionSeconds).toBe(2);
  });
});

describe('a corrupt store is discarded, never half-trusted', () => {
  it('survives garbage', () => {
    sessionStorage.setItem('vip.playback.memory.v1', 'not json at all');
    expect(recall('clip-1')).toBeUndefined();
    remember('clip-1', { positionSeconds: 5 });
    expect(recall('clip-1')?.positionSeconds).toBe(5);
  });

  it('survives a structurally wrong file', () => {
    sessionStorage.setItem('vip.playback.memory.v1', JSON.stringify({ entries: 7 }));
    expect(recall('clip-1')).toBeUndefined();
  });
});

describe('⚠️ which positions are worth restoring', () => {
  it('does not restore the first second', () => {
    /* Restoring 0.4 s looks like a player that cannot find the start. */
    expect(restorablePosition({ positionSeconds: 0.4 }, 600)).toBeUndefined();
  });

  it('does not restore the last frame of a clip that was watched to the end', () => {
    expect(restorablePosition({ positionSeconds: 599.5 }, 600)).toBeUndefined();
  });

  it('restores the middle', () => {
    expect(restorablePosition({ positionSeconds: 300 }, 600)).toBe(300);
  });

  it('⚠️ clamps a position that outran the duration rather than stranding the player past the end', () => {
    expect(restorablePosition({ positionSeconds: 9999 }, 0)).toBe(9999);
    expect(restorablePosition({ positionSeconds: 300 }, 0)).toBe(300);
  });

  it('returns undefined, not zero, when there is nothing to restore', () => {
    expect(restorablePosition(undefined, 600)).toBeUndefined();
    expect(restorablePosition({}, 600)).toBeUndefined();
    expect(restorablePosition({ positionSeconds: Number.NaN }, 600)).toBeUndefined();
  });
});
