/**
 * **Assign a verification's cameras for AI processing** (P-8 Phase 6).
 *
 * ### ⚠️ Why every pre-Phase-6 verification needs this
 *
 * Before Camera Processing Assignment, a camera whose stream was started had its frames analysed
 * automatically — perception was one deployment variable and it applied to everything. From Phase 6
 * the deployment ships with `MEDIA_ASSIGNMENT_ENABLED=1`, and **a camera with no assignment is never
 * analysed**. That is the milestone's entire point.
 *
 * So every verification that creates a camera and then expects inference, tracking or publishing has
 * to say so. Without this call they measure a correctly-behaving deployment declining to analyse an
 * unassigned camera, and report it as a broken bridge. The P-8 Phase 5 bridge run went red with 12
 * failures the first time the gate was switched on, which is how this file came to exist.
 *
 * ### ⚠️ This is not a workaround — it is the scripts catching up with the platform
 *
 * The alternative was shipping the gate switched off so the old verifications kept passing. That
 * would have left the platform with a control plane the deployment does not obey, verified by
 * nothing. A verification that has to be updated when behaviour changes is a verification that was
 * measuring the behaviour.
 *
 * ### Failure posture
 *
 * `assignCameras` **throws** when the control plane refuses, because a verification that silently
 * proceeds with unassigned cameras produces exactly the confusing red this file exists to prevent.
 * `releaseCameras` is best-effort: it runs in cleanup paths where the interesting failure has
 * already been reported.
 */

/** Default profile. The one every deployment can run — see `BUILT_IN_PROFILES`. */
export const VERIFICATION_PROFILE = 'person-tracking';

/**
 * Enable AI on each camera and wait for the enforcement point to pick the plan up.
 *
 * @param api      the caller's `api(path, opts)` helper — each script has one
 * @param headers  authenticated headers (bearer + content-type)
 * @param cameraIds cameras to assign
 * @param opts.settleMs how long to wait for the plan to reach the data plane. ⚠️ Default 12 s: the
 *   poll interval is 5 s, and a verification that races the system it measures is flaky rather than
 *   strict.
 */
export async function assignCameras(api, headers, cameraIds, opts = {}) {
  const profileId = opts.profileId ?? VERIFICATION_PROFILE;
  const settleMs = opts.settleMs ?? 12_000;
  const assigned = [];
  for (const cameraId of cameraIds) {
    if (cameraId === undefined || cameraId === null) continue;
    const res = await api(`/camera/assignments/${cameraId}/enable`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId }),
    });
    if (res.status !== 200) {
      throw new Error(
        `could not assign ${cameraId} for AI processing (HTTP ${res.status}): ` +
          `${res.json?.error?.message ?? res.text?.slice(0, 200) ?? ''}`,
      );
    }
    assigned.push(cameraId);
  }
  if (assigned.length > 0) await new Promise((r) => setTimeout(r, settleMs));
  return assigned;
}

/**
 * Remove the assignments a verification created.
 *
 * ⚠️ Call this **before** deleting the cameras. A deleted camera whose assignment survives leaves the
 * plan naming a camera that no longer exists, and the enforcement point holds a queue for it.
 */
export async function releaseCameras(api, headers, cameraIds) {
  for (const cameraId of cameraIds) {
    if (cameraId === undefined || cameraId === null) continue;
    try {
      await api(`/camera/assignments/${cameraId}`, {
        method: 'DELETE',
        headers: { authorization: headers.authorization },
      });
    } catch {
      /* best effort — cleanup must never mask the failure that brought us here */
    }
  }
}

/**
 * **Raise the runtime's declared camera capacity for the duration of a ladder, and restore it.**
 *
 * ### ⚠️ Why this exists, and why it belongs here rather than in each benchmark
 *
 * The seeded runtime declares **4** cameras — the provisional sizing figure. From P-8 Phase 6 the
 * control plane enforces that figure, so a ladder asking for an 8-camera rung is refused with a 409
 * by the control plane **doing exactly its job**. A ladder that stopped there would be measuring the
 * refusal path and reporting it as the cost of eight cameras.
 *
 * ⚠️ **Three benchmarks went dark for a day because this was fixed one script at a time.** The
 * P-8 Phase 7 loitering ladder hit the 409, and the repair was made inside that one file. The first
 * full nightly afterwards found `benchmark`, `tracking-benchmark` and `publisher-benchmark` all
 * failing at their 8-camera rung with the identical error — each had climbed to 16 the week before.
 * The instance was fixed and the class was not. This function is the class.
 *
 * ### ⚠️ It raises a DECLARATION, not a capability
 *
 * `maxCameras` is what the operator told the platform this runtime can take. Raising it does not make
 * the host faster, and the ladder's job is precisely to find out what happens past the declared
 * figure. **The sizing policy is untouched by this**: no capacity number is published from one run,
 * and a rung that drops frames reports dropped frames. What is removed is the control plane refusing
 * before the measurement can be taken.
 *
 * @returns a `restore()` — call it in a `finally`, always. A verification that leaves a raised
 *   declaration behind hands the next run a deployment that will accept more than it can serve.
 */
export async function raiseRuntimeCapacity(api, headers, needed) {
  const runtimes = (await api('/camera/processing-runtimes', { headers })).json?.data ?? [];
  const runtime = runtimes[0];
  if (runtime === undefined) {
    /* No control plane to raise. Older deployments, and the caller's ladder will fail honestly. */
    return async () => {};
  }
  const originalMax = runtime.maxCameras;
  await api(`/camera/processing-runtimes/${runtime.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ maxCameras: needed }),
  });
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    try {
      await api(`/camera/processing-runtimes/${runtime.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ maxCameras: originalMax }),
      });
    } catch {
      /* best effort — see releaseCameras */
    }
  };
}

/**
 * **Assign, and report a refusal instead of throwing.** For **ladders only**.
 *
 * ### ⚠️ A refusal is a measurement, not an error
 *
 * `assignCameras` throws, and for an end-to-end run that is right: a verification that proceeds with
 * unassigned cameras measures a correctly-behaving deployment declining to analyse them and calls the
 * bridge broken. A **ladder** is different. It climbs until something gives, and the rung where the
 * control plane says *no* is a result — the two refusals seen in practice are
 * `every eligible runtime is at capacity` (the declaration is full) and
 * `no registered runtime is healthy enough to accept a camera` (the runtime degraded under the load
 * the previous rung applied, which is the ladder finding the edge it exists to find).
 *
 * ⚠️ **Throwing there costs two things, and the second is worse than the first.** The rungs already
 * measured are discarded — the 2026-08-06 run threw away 1, 2, 4, 8 and 12 cameras of real data and
 * reported `no capacity samples were written`. And in a script without a top-level `finally`, the
 * throw skips cleanup, so **every camera the ladder assigned and every raised capacity declaration
 * leaks into the next stage**. That is precisely what happened: `hardening` left `maxCameras: 24` and
 * a dozen assigned cameras behind, and the next three ladders — including the milestone's own —
 * failed with 409 at their *first* rung. One unhandled throw took out four stages.
 *
 * @returns `{ ok: true, assigned }` or `{ ok: false, reason }`. Callers `break` and publish what they
 *   measured, naming the rung that was refused.
 */
export async function tryAssignCameras(api, headers, cameraIds, opts = {}) {
  try {
    return { ok: true, assigned: await assignCameras(api, headers, cameraIds, opts) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
