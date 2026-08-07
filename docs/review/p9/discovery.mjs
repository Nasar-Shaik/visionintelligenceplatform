/**
 * P-9 · **A1 — is ONVIF discovery actually wired in the deployed product?**
 *
 *   node docs/review/p9/discovery.mjs
 *
 * ### What this exists to catch
 *
 * ONVIF discovery and staged stream probing were built in P-1/P-2, tested, and placed by
 * [ADR-0023](../../adr/ADR-0023-onvif-discovery-placement.md). Both ends shipped:
 * `ai/inference/onvif.py`, `POST /discovery/onvif`, `POST /streams/validate`,
 * `HttpDiscoveryProvider`, `HttpStreamProbe`. And **`CAMERA_DISCOVERY_URL` was unset in every
 * deployment from P-1 to P-8**, so all of it fell back to the `Unavailable*` implementations and
 * neither capability ever ran in a deployed product.
 *
 * Measured before the fix, against the production stack:
 *
 * ```
 * { "devices": [], "probedSeconds": 0,
 *   "unavailable": "network discovery is not configured for this deployment" }
 * ```
 *
 * ⚠️ That is [L-56](../../project/KNOWN_LIMITATIONS.md) exactly — a capability enablable in the
 * contract and unusable in every deployment, because nothing had ever tried.
 *
 * ### ⭐ The check that matters
 *
 * **`unavailable` absent is the assertion, not `devices.length`.** There are no ONVIF devices on a
 * docker bridge network, so a correct run finds nothing — and "found nothing" and "could not look"
 * are the two answers this milestone exists to keep apart
 * ([ADR-0039](../../adr/ADR-0039-absent-is-null.md)). A check written against `devices.length > 0`
 * would fail forever on correct behaviour and pass the day someone plugged in a camera, which is
 * precisely backwards: it would be green only when it had stopped being needed.
 *
 * ⚠️ **This asserts wiring, not ONVIF.** No device has answered. [L-1](../../project/KNOWN_LIMITATIONS.md)
 * stands until Track B.
 */
import {
  api,
  check,
  checkIntegrity,
  containerEnv,
  exit,
  finding,
  H,
  heading,
  login,
  read,
} from './_p9.mjs';

heading('deployment integrity');
checkIntegrity();

heading('configuration');
const configured = containerEnv('vip-prod-camera-1', 'CAMERA_DISCOVERY_URL');
{
  check(
    configured !== undefined && configured !== '',
    'CAMERA_DISCOVERY_URL is set in the running camera container',
    configured ?? '(unset)',
  );
  /* ⚠️ Asserting the value, not just its presence. A URL pointing at a host that does not exist is
     "configured" by any test that only checks for a non-empty string, and would then report
     `unavailable: unreachable` — a different failure wearing the same clothes. */
  check(
    /^https?:\/\/[^/]+/.test(configured ?? ''),
    'and it is a well-formed base URL',
    configured ?? '(unset)',
  );
}

await login();

heading('discovery runs');
{
  const t0 = Date.now();
  const res = await api('/camera/cameras/discover', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ timeoutSeconds: 3 }),
  });
  const elapsed = Date.now() - t0;
  const data = res.json?.data;

  check(res.status === 200, 'POST /cameras/discover answers 200', `status ${res.status}`);
  check(data !== undefined, 'and returns a result envelope');

  /* ⭐ The assertion this whole task was for. */
  check(
    data !== undefined && data.unavailable === undefined,
    'discovery is NOT reported unavailable',
    data?.unavailable ?? 'no `unavailable` reason — the provider ran',
  );

  check(
    typeof data?.probedSeconds === 'number' && data.probedSeconds > 0,
    'the probe window was actually spent',
    `probedSeconds=${data?.probedSeconds}`,
  );

  /* The transport must not have short-circuited: a provider that returns instantly did not probe. */
  check(elapsed >= 2500, 'the call took at least the requested window', `${elapsed}ms wall clock`);

  check(Array.isArray(data?.devices), 'devices is an array');

  if (Array.isArray(data?.devices) && data.devices.length === 0) {
    finding(
      'zero devices answered, and that is the expected result here',
      'a docker bridge network has no ONVIF hardware on it; L-1 stands until Track B',
    );
  } else if (Array.isArray(data?.devices)) {
    finding(
      `${data.devices.length} device(s) answered WS-Discovery`,
      'unexpected on this network — inspect before trusting any downstream result',
    );
  }
}

heading('targeted negotiation (the routed-estate path)');
{
  /* ⚠️ Multicast does not cross a routed boundary, so a real estate onboards by naming an endpoint.
     That path must also be wired — and must fail *honestly* against an address with nothing on it. */
  const res = await api('/camera/cameras/discover', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ timeoutSeconds: 3, endpoint: 'http://198.51.100.7/onvif/device_service' }),
  });
  const data = res.json?.data;
  check(res.status === 200, 'a targeted probe answers 200 rather than throwing', `status ${res.status}`);
  check(
    data !== undefined && data.unavailable === undefined,
    'and is not reported unavailable',
    data?.unavailable ?? 'the provider ran',
  );
  check(
    Array.isArray(data?.devices) && data.devices.length === 0,
    'an address with no device on it yields no devices',
    `${data?.devices?.length ?? '?'} device(s)`,
  );
}

heading('nothing else moved');
{
  /* A1 changes one environment variable. The regression surface is small and worth naming.
     ⚠️ Two instrument defects lived on this one line. `/ready` is gated by the gateway like
     everything under `/api`, so it needs a token — calling it anonymously reported a camera-service
     regression that was the gateway doing its job. And it answers the *health* envelope
     (`{status, checks}`), not the API envelope (`{success, data}`), so the shared `read()` helper
     correctly refused it. Both failures looked like the product; neither was. */
  const ready = await api('/camera/ready', { headers: H });
  check(
    ready.status === 200 && ready.json?.status === 'pass',
    'camera /ready still passes',
    `status ${ready.status} · ${ready.json?.status ?? '?'}`,
  );

  const cams = await read('/camera/cameras?limit=1');
  check(cams.ok, 'the camera list still answers', `status ${cams.status}`);

  /* The runtime gained no new job: discovery is read-only and creates no session (ADR-0023). */
  const runtime = await read('/camera/processing-runtimes');
  const runtimes = Array.isArray(runtime.data) ? runtime.data : (runtime.data?.runtimes ?? []);
  check(
    runtime.ok && runtimes.length > 0,
    'the assignment control plane still sees its runtime',
    runtime.ok ? `${runtimes.length} runtime(s)` : `status ${runtime.status}`,
  );
}

exit('A1 discovery wiring');
