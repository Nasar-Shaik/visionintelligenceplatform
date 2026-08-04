/**
 * ⚠️ Pins the fix for the `/cameras` white screen found by the roadmap review (2026-08-04).
 *
 * One demo camera in nine carried `health.status: "degraded"` — a *lifecycle* word that is not a
 * member of the frozen `CameraHealthStatus` enum. The seed writes straight to Mongo, so nothing
 * validated it. `HEALTH_KIND["degraded"]` returned `undefined`, `statusTokens(undefined)` returned
 * `undefined`, and reading `.label` off that threw inside `StatusIndicator` — taking the whole page
 * down for every operator in three of the four demo tenants.
 *
 * ⚠️ **What makes it worth a test file of its own is how it survived.** P-5.9 audited eleven pages
 * and reported zero findings, because the audit measured overflow, tap targets, focus rings and
 * contrast. A page that has crashed has no overflow, no unlabelled controls and no contrast
 * failures. **It scores perfectly.** The first assertion any UI check must make is that the page
 * rendered at all.
 *
 * These tests use the real string that was in the database, not a placeholder, so the case cannot be
 * "fixed" by narrowing the type and leaving the runtime path unguarded.
 */
import { describe, expect, it } from 'vitest';
import { statusTokens } from '@/lib/status';
import { HEALTH_KIND, cameraLifecyclePresentation, healthPresentation } from './cameraPresentation';

describe('statusTokens', () => {
  it('⚠️ never returns undefined for an unmapped kind — the read that threw', () => {
    expect(statusTokens(undefined)).toBeDefined();
    expect(statusTokens(undefined).label).toBe('Idle');
    // @ts-expect-error — the runtime case a `Record` lookup produces after a stale map.
    expect(statusTokens('degraded')).toBeDefined();
  });

  it('still resolves the four real kinds', () => {
    expect(statusTokens('ok').label).toBe('OK');
    expect(statusTokens('error').token).toBe('status-error');
  });
});

describe('healthPresentation', () => {
  it('⚠️ renders the stored value rather than crashing when it is not in the enum', () => {
    /* The exact record that white-screened the page. */
    expect(healthPresentation('degraded')).toEqual({ status: 'idle', label: 'degraded' });
  });

  it('maps every status the contract actually declares', () => {
    expect(healthPresentation('online')).toEqual({ status: 'ok', label: 'Online' });
    expect(healthPresentation('unhealthy')).toEqual({ status: 'warn', label: 'Unhealthy' });
    expect(healthPresentation('offline')).toEqual({ status: 'error', label: 'Offline' });
    expect(healthPresentation('unknown')).toEqual({ status: 'idle', label: 'Unknown' });
  });

  it('⚠️ covers the enum exhaustively, so a contract addition cannot go unmapped silently', () => {
    /* `HEALTH_KIND` is `Record<CameraHealthStatus, …>`; its keys are the enum. If a member is added
       to the contract, this list changes and the compiler forces the map to change with it. */
    expect(Object.keys(HEALTH_KIND).sort()).toEqual(['offline', 'online', 'unhealthy', 'unknown']);
  });
});

describe('cameraLifecyclePresentation', () => {
  it('renders an unknown lifecycle state as itself in the idle colour', () => {
    expect(cameraLifecyclePresentation('teleported')).toEqual({
      status: 'idle',
      label: 'teleported',
    });
  });

  it('keeps `configured` deliberately idle rather than ok', () => {
    /* A camera set up but never measured is not a healthy camera — see the map's own note. */
    expect(cameraLifecyclePresentation('configured')).toEqual({
      status: 'idle',
      label: 'Configured',
    });
    expect(cameraLifecyclePresentation('monitoring').status).toBe('ok');
  });
});
