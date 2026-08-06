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
