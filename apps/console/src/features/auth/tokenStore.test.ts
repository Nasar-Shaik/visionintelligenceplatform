/**
 * ⚠️ What must NOT survive a sign-out.
 *
 * P-5.8 logged out of the production deployment and read `localStorage`. Tokens were handled
 * correctly — an access token is never persisted at all — but `vip.workspace.state.<tenant>.<user>`
 * remained, carrying the principal id and **the incident ids the operator had open**. On a shared
 * SOC workstation that tells the next person who was here and what they were investigating.
 *
 * No evidence was cached outside approved storage, so this is not the constraint about evidence
 * caching; it is investigative metadata with no reason to outlive a session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { tokenStore } from './tokenStore';

describe('tokenStore.clear', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes the refresh token and tenant id', () => {
    tokenStore.save('refresh-abc', 'tnt_dev');
    expect(tokenStore.getRefreshToken()).toBe('refresh-abc');
    tokenStore.clear();
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(tokenStore.getTenantId()).toBeNull();
  });

  it('⚠️ removes workspace state, which names the incidents the operator had open', () => {
    localStorage.setItem(
      'vip.workspace.state.tnt_dev.usr_dev_owner',
      JSON.stringify({ view: { currentIncidentId: 'inc-1' }, tabs: [{ incidentId: 'inc-1' }] }),
    );
    tokenStore.save('refresh-abc', 'tnt_dev');

    tokenStore.clear();

    expect(localStorage.getItem('vip.workspace.state.tnt_dev.usr_dev_owner')).toBeNull();
  });

  it('⚠️ removes EVERY principal’s workspace state, not just the one signing out', () => {
    /* At logout the caller may no longer know which principal it was; leaving one behind would
     * defeat the point on precisely the shared terminal this protects. */
    localStorage.setItem('vip.workspace.state.tnt_dev.usr_a', '{}');
    localStorage.setItem('vip.workspace.state.tnt_dev.usr_b', '{}');
    localStorage.setItem('vip.workspace.state.tnt_other.usr_c', '{}');

    tokenStore.clear();

    expect(Object.keys(localStorage).filter((k) => k.startsWith('vip.workspace.state.'))).toEqual(
      [],
    );
  });

  it('leaves unrelated keys alone', () => {
    localStorage.setItem('vip.console.theme', 'dark');
    localStorage.setItem('some.other.app', 'value');

    tokenStore.clear();

    expect(localStorage.getItem('vip.console.theme')).toBe('dark');
    expect(localStorage.getItem('some.other.app')).toBe('value');
  });

  it('is safe to call twice', () => {
    tokenStore.save('r', 't');
    tokenStore.clear();
    expect(() => tokenStore.clear()).not.toThrow();
  });
});
