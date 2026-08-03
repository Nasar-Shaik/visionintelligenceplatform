# P-5.7 verification results

Everything below was run against the deployed stack — Mongo, MinIO, NATS, ten services, the console
— in a real browser. Figures are measured, not estimated.

## Operator workflow (browser only) — 14/14

| Step                                  | Result                                        |
| ------------------------------------- | --------------------------------------------- |
| Login page loads                      | ✅                                            |
| Sign in as operator                   | ✅                                            |
| Open the incidents queue              | ✅                                            |
| Open an incident                      | ✅                                            |
| Reach the Investigation Workspace     | ✅ _(via the action added in this milestone)_ |
| The player shows real decoded footage | ✅ `videoWidth 1280`, `duration 10`           |
| Press play from the UI                | ✅ playhead advances                          |
| Timeline present and scrubs           | ✅                                            |
| Create a bookmark                     | ✅ persisted, toast confirmed                 |
| Evidence metadata readable            | ✅ integrity hash shown                       |
| Evidence chain visible                | ✅                                            |
| Export entry point present            | ✅ disabled with a stated reason (TD-16)      |
| Switch evidence item                  | ✅ 3 items offered                            |
| Keyboard shortcut sheet               | ✅ generated from the frozen registry         |

**Zero console errors. Zero failed requests.**

## Security — 19/19

| Check                                                     | Result                        |
| --------------------------------------------------------- | ----------------------------- |
| Unauthenticated playback                                  | 401                           |
| Forged token                                              | 401                           |
| Client-supplied tenant header cannot change scope         | scope resolved from the token |
| Spoofed tenant header lists no foreign rows               | 0 foreign rows                |
| Unknown evidence id                                       | 404, not 500                  |
| Playback URL carries a real HMAC signature                | `X-Amz-Signature` present     |
| Fresh signed URL fetches the media                        | 200 `video/mp4`               |
| Tampered signature                                        | **403**                       |
| Object path swapped inside a signed URL                   | **403**                       |
| Signed URL TTL                                            | 900 s                         |
| Altered expiry                                            | **403**                       |
| Viewer cannot create a bookmark                           | 403                           |
| Playback recorded in the chain of custody                 | ✅                            |
| Read another tenant's evidence record                     | **404**                       |
| Open playback on another tenant's evidence                | **404**                       |
| Read another tenant's custody chain                       | **404**                       |
| Download another tenant's evidence                        | **404**                       |
| No foreign row in any listing                             | ✅                            |
| ⚠️ A **shared `incidentId`** does not leak across tenants | ✅                            |

The last one was planted deliberately: a foreign evidence row carrying the _same_ incident id the
workspace filters by. Isolation held.

⚠️ Two earlier "failures" here were **my assertions being wrong**, not product defects: the service
ignores the client `x-tenant-id` and scopes from the token, which is correct. Corrected rather than
reported.

## Network resilience — 5/5

| Scenario                             | Result                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| Slow 3G (400 kbps, 400 ms RTT)       | workspace renders, no panel failure — 15.8 s to first player surface |
| Offline                              | named on screen (offline badge)                                      |
| Reconnect                            | clears **without a page refresh**                                    |
| Backend stopped under the running UI | app does not blank; panels report rather than crash                  |
| After logout                         | no JWT, no signed URL, no credential in local or session storage     |

## Scale

Seeded directly into the store (scaffolding, since removed): **150 cameras · 5,000 incidents ·
5,000 bookmarks · 50,001 events**.

| Read                           | Latency   | Rows |
| ------------------------------ | --------- | ---- |
| Incidents page 1               | **11 ms** | 50   |
| Incidents filtered by status   | **5 ms**  | 50   |
| Incidents filtered by severity | **6 ms**  | 50   |
| Events page 1                  | **5 ms**  | 50   |
| Events by type                 | **5 ms**  | 50   |
| Events by camera               | **4 ms**  | 50   |
| Bookmarks for one incident     | **11 ms** | 200  |
| Incident timeline (3-way join) | **55 ms** | 6    |

Browser: incident queue rendered in **982 ms** with 5,000 rows behind it (50 drawn — keyset paging);
workspace opened in **3.4 s** with no panel failure.

## Long-session soak

40 full investigation cycles — navigate, open workspace, switch evidence, mount and unmount the
media element, play:

| Metric          | Before   | After    | Δ            |
| --------------- | -------- | -------- | ------------ |
| JS heap         | 40.22 MB | 40.34 MB | **+0.12 MB** |
| DOM nodes       | 2,617    | 2,620    | **+3**       |
| Event listeners | 489      | 489      | **0**        |

Queue still rendered in **917 ms** afterwards. This is the P-5.6 media-element release doing its job.

## Responsive

| Viewport          | Horizontal overflow                                               |
| ----------------- | ----------------------------------------------------------------- |
| 1680×1050 desktop | none                                                              |
| 1366×800 laptop   | none                                                              |
| 1024×768 tablet   | ⚠️ **overflowed** → fixed (fixed side columns relaxed below `xl`) |
| 414×896 phone     | none                                                              |

## Not verified

- **Production deployment**: no reverse proxy, HTTPS, CSP, compression or cache headers. The stack
  ran as `pnpm dev:*` against containerised infrastructure. TD-32.
- **Real CCTV / NVR / RTSP**: no hardware. TD-27, TD-28.
- **Light theme**: the console is dark-first by design; no light theme ships, so there was nothing to
  review. Not a gap, a scope statement.
- **Token expiry mid-playback**: the _signed-URL_ expiry path is implemented and unit-tested, and
  session expiry is exercised; a genuine access-token expiry during playback was not forced.
