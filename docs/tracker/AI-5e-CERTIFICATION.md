# AI-5e — Production Certification Framework

_Status: **implemented, awaiting review** · Author: Claude · Date: 2026-08-01 · **AI Runtime Architecture v1.0 — final milestone**_

> Authorized by the Architect as the **Production Certification Framework** milestone, with an explicit
> redefinition: _"AI-5e is NOT a hardware certification milestone… The software can build the framework.
> Real hardware validates the framework. Therefore AI-5e should produce everything required for
> production certification while making no claims that cannot be measured on physical hardware."_
>
> And a re-prioritization: _"My immediate objective is NOT hardware certification. Instead, my highest
> priority is proving that the AI Runtime Architecture v1.0 can reliably detect and analyze real-world
> CCTV scenarios using recorded surveillance footage."_
>
> Both are reflected here. The certification framework is complete; **no compatibility claim is made
> about any physical device**, and the CCTV dataset library is the first-priority deliverable rather
> than an afterthought.

---

## 1. The one idea this milestone rests on

Everything the platform has proved so far was proved in simulation. Simulation proves **architecture**.
It cannot prove that a Hikvision on a warehouse VLAN streams for 72 hours without the decoder wedging,
and it cannot prove the system notices a shoplifter.

So AI-5e introduces **`EvidenceClass`**, and threads it through every artifact it produces:

```
simulated  →  recorded-footage  →  hardware
   ↓                 ↓                  ↓
proves the      proves the         proves production
plumbing        perception         readiness
```

Three rules follow, and all three are **structural** — expressed in code and negative-tested, not
written in a paragraph someone has to remember:

1. **A report is only as strong as its weakest check.** `weakest()` takes the minimum across every
   check; one simulated measurement downgrades an otherwise-hardware report.
2. **`certified` is unreachable without `hardware`.** `CertificationHarness._status_for()` returns
   `pending-validation` regardless of how many checks passed, when the evidence is not hardware.
3. **`production` maturity is unreachable without `hardware`.** `maturity.promote()` refuses, listing
   every missing artifact at once.

The negative control lives at
`tests/test_certification.py::EvidenceClassTest::test_a_flawless_simulated_run_is_still_not_certified`.
A complete run against a simulated source, with every check green, still returns `pending-validation`.
If that test can be deleted without anything else failing, the framework can certify itself from its own
simulations — and every certification the platform ever issues becomes worthless.

**Why this is worth the ceremony:** a certification framework that quietly certifies itself is worse
than having none. Having none leaves a known unknown; a self-certifying one converts it into a false
assurance that someone will eventually quote to a customer.

## 2. What was built

| #   | Deliverable                   | Where                                                                                                     |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | ONVIF discovery + negotiation | `ai/inference/onvif.py`                                                                                   |
| 2   | Real RTSP production path     | `RtspStreamSource` in `ai/inference/stream_source.py`                                                     |
| 3   | Certification harness         | `ai/inference/certification.py`                                                                           |
| 4   | Compatibility matrix          | `ai/inference/camera_registry.py` + `profiles/cameras/*.json` (11 rows)                                   |
| 5   | Soak framework                | `ai/inference/soak.py`                                                                                    |
| 6   | Edge packaging                | `edge/packaging/`                                                                                         |
| 7   | Capability promotion workflow | `ai/inference/maturity.py`                                                                                |
| 8   | Customer validation package   | `build_bundle()` in `ai/inference/certification.py`                                                       |
| r1  | Camera compatibility registry | `ai/inference/profiles/cameras/` (data, not code)                                                         |
| r2  | Hardware recommendation guide | `ai/inference/sizing.py` + [HARDWARE_RECOMMENDATIONS](../architecture/future/HARDWARE_RECOMMENDATIONS.md) |
| r3  | Certification CLI             | `ai/inference/certify_cli.py` (`vip certify`)                                                             |
| p1  | CCTV footage evaluation       | `ai/inference/evaluation.py` + `evaluate_cli.py`                                                          |
| p2  | AI Playground workbench       | `timeline.json` · `incidents.json` · `evidence.json` · `performance.json` · `report.html`                 |
| p3  | CCTV dataset library          | `ai/datasets/<scenario>/` (18 scenarios) + `ai/inference/dataset.py`                                      |

## 3. ONVIF discovery (deliverable 1)

Every camera on a customer's network already knows its manufacturer, model, firmware, stream profiles,
resolutions, frame rates, codecs and whether it can pan. The platform has been asking an operator to
type all of it in.

Discovery replaces the typing and — more importantly — replaces **probing**. The runtime consumes
declared `CameraCapabilities` and never opens a stream to find out what it is. Probing costs a
connection and a decode on every session start; on a 64-camera site after a power cut, that is 64
connections nobody needed.

**Two seams, both Protocols, both with deterministic simulated implementations:**

| Seam                 | Real                    | Simulated                     |
| -------------------- | ----------------------- | ----------------------------- |
| `DiscoveryTransport` | `UdpDiscoveryTransport` | `SimulatedDiscoveryTransport` |
| `SoapTransport`      | `HttpSoapTransport`     | `SimulatedSoapTransport`      |

That is what lets the whole ONVIF path be unit-tested with no network, no camera and no threads — 22
tests against XML fixtures shaped like what real devices return, including the awkward ones.

**Design decisions worth recording:**

- **Sub-stream selection is "smallest at or above the analysis floor."** Analyzing a 4K main stream
  when a 640×360 sub-stream would do wastes decode and inference budget on every frame forever. But
  going below ~640×360 costs detection recall, so the rule falls back to the _largest_ available when
  every profile is under the floor — a low-resolution-only device should analyze its best stream,
  not its worst.
- **Credentials in a returned stream URI are stripped to a path.** Devices routinely hand back
  `rtsp://admin:hunter2@…`. Storing that would put a camera password into the camera record, which is
  exactly what `credentialRef` exists to prevent.
- **The password never enters the SOAP envelope.** WS-Security UsernameToken carries
  `Base64(SHA1(nonce + created + password))`. ONVIF is routinely spoken over plain HTTP inside a
  customer LAN, so a plaintext token would put a camera password on the wire in cleartext.
- **Optional services degrade to negative capabilities.** A device refusing `GetCapabilities` still
  negotiates; a device refusing `GetProfiles` raises, because without profiles there is nothing to
  configure and producing a camera record that cannot stream would be worse than failing.
- **One malformed responder does not end a scan.** An installer with fifteen working cameras and one
  hostile one must be able to onboard the fifteen.

**A bug this found:** the first parser read the service address from `a:Address` inside the
`EndpointReference`. That field is the device's `urn:uuid:` identity, not a callable URL — the address
lives in `d:XAddrs`. Against a realistic fixture the discovery returned zero devices every time. It is
the classic WS-Discovery mistake and it would have been invisible until the first real scan.

## 4. The real RTSP path (deliverable 2)

`RtspStreamSource` is a **named class, not a new implementation**. `OpenCvStreamSource` already carried
the transport-neutral capture loop, so RTSP-specific behaviour is exactly two things and both are
configuration:

1. **Profile paths** — `for_profile()` builds the sub-stream URI from declared capabilities, delegating
   to `deployment.resolve_stream_settings()`, the _same_ function the scheduler already uses. One
   implementation of "which stream do we analyze". A second copy would eventually disagree, and the
   disagreement would surface as a camera that benchmarks against the sub-stream and runs against the
   main one.
2. **Transport preference** — TCP by default. UDP loses frames on any congested or wireless link, and a
   "flaky camera" that is really a UDP problem costs days.

Everything else — reconnect, redaction, failure categories, frame accounting — is inherited unchanged.
**The declared source type is preserved, not rewritten**: an ONVIF camera streams over RTSP, but the
operator configured `onvif`, and the runtime dispatches on declared type and never launders it
(AI-5b refinement 4).

The property that matters: `SimulatedStreamSource` and `RtspStreamSource` are interchangeable through
configuration alone. No runtime logic knows which is active — which is what lets a scenario be
developed against a simulation and then certified against a camera with **no code change**.

## 5. Certification harness (deliverable 3)

The harness drives the **real** runtime — `SessionSupervisor` → `SessionRunner` → `StreamPipeline` —
against whatever `StreamSource` it is given, and reads the diagnostics the runtime already publishes.
It adds no instrumentation. A result obtained from a bespoke certification path would say nothing about
production.

**Automatic checks** (derived from `SessionRunner.diagnostics()`):

| check                                                    | what it catches                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`                                                | the source never opened                                                                                                                                    |
| `stream-acquisition`                                     | connected and delivered nothing — wrong profile path, a codec the decoder refuses. **Invisible to a connectivity check**, and the most common real failure |
| `credential-redaction`                                   | an inline credential in the URI, or a supplied secret anywhere in the diagnostics document (including nested error strings)                                |
| `frame-accounting`                                       | `framesSkipped` (sampling) and `framesDropped` (loss) collapsing into one number                                                                           |
| `declared-capabilities`                                  | the runtime probing instead of reading                                                                                                                     |
| `stream-profile-selection`                               | a multi-profile device with no `preferredForAnalysis` — warns, does not block                                                                              |
| `fps-within-declared-range`                              | asking a device for a rate it cannot produce                                                                                                               |
| `sustained-fps` · `inference-latency-p95` · `frame-loss` | budget breaches (only when a budget constrains them)                                                                                                       |

**Two-phase by design.** `observe_session()` collects what the runtime can measure by itself;
`record()` accepts measurements only a human can make — pulling a cable, power-cycling a DVR. Checks
nobody supplied stay `not-executed` **and keep blocking**, so an incomplete run reads as incomplete
rather than as a pass with gaps. `skipped` and `not-executed` are distinct and neither is ever treated
as a pass.

`connect` passing while `stream-acquisition` fails is precisely the diagnosis an installer needs: the
network is fine, the stream is not.

## 6. Compatibility matrix (deliverable 4)

Eleven rows ship in `ai/inference/profiles/cameras/`. **Every one is `Pending Validation`**, with no
evidence and no certification date, and a test asserts it stays that way:

| device                                   | kind                | status             |
| ---------------------------------------- | ------------------- | ------------------ |
| Hikvision · Dahua · CP Plus · Axis · UNV | camera              | Pending Validation |
| Generic ONVIF · Generic RTSP             | camera              | Pending Validation |
| Generic DVR · Generic NVR                | dvr / nvr           | Pending Validation |
| USB webcam · Recorded MP4                | encoder / recording | Pending Validation |

These rows are a **to-do list, not a support matrix**. What they do carry is what is already known and
would otherwise be re-learned at every site: that Hikvision channel 102 is the sub-stream, that Dahua
speaks a different ONVIF dialect, that CP Plus ONVIF support varies by firmware and should be assumed
absent.

`render_matrix()` prints `Pending Validation` in full rather than a tick or a dash. A symbol invites an
optimistic reading; words do not.

**Discovery never changes a status.** `CameraRegistry.observe()` records everything ONVIF learned and
leaves the row pending — the easiest possible way for this registry to start lying would be to let a
successful `GetDeviceInformation` be mistaken for a passing certification run.

**A `certified` row cannot be constructed without evidence.** The dataclass raises if the status is
`certified` with an empty `evidence` list, or with an evidence class below `hardware`. Without that,
"certified" degrades into "someone was fairly sure".

## 7. Soak framework (deliverable 5)

**Drift, not level.** Every failure mode that matters in surveillance is slow. A runtime that leaks
2 MB an hour looks perfect in a benchmark and dies on a Tuesday night three weeks after handover, in a
shop with no engineer. So the framework never asks "is memory acceptable"; it asks "**is memory the
same at hour 24 as it was at hour 1**", which a short run structurally cannot answer.

- **Only the adverse direction counts.** Memory falling 30% is not a failure; fps falling 30% is. A
  soak that judged magnitude rather than direction would fail every run where the machine got quieter
  overnight.
- **A metric that started at zero reports 0% drift**, not infinity — a first sample taken before the
  pipeline warmed up would otherwise fail every run.
- **A metric with one sample is skipped.** One reading has no trend, and inventing one would be
  fabrication.
- **A short run reports the shortfall as a blocker.** A 3-hour abort can never be mistaken for a
  completed 24-hour soak.
- **Excessive restarts fail regardless of drift.** A runtime that recovers forty times in a night is
  not stable, however good its final numbers look.
- **The clock is injected**, so a 72-hour soak is asserted in microseconds. A soak you cannot run in
  CI is a soak nobody runs; the _result_ needs real hours, the _procedure_ deserves regression tests.

## 8. Edge packaging (deliverable 6)

Five targets in `edge/packaging/targets.json` — Docker generic, mini-PC, Intel NUC, Jetson, industrial
PC — declared as data so a new device is a data change. `intel-nuc` builds the same image as `mini-pc`
and is a separate row anyway, because the question a NUC raises is thermal and only a soak answers it.

The Dockerfile makes four decisions worth naming: it **runs unprivileged** (an edge box sits on a
customer's network holding camera credentials), **defaults RTSP to TCP**, **uses `tini`** (OpenCV
leaves decoder subprocesses behind; without an init a long-running container accumulates zombies until
it cannot fork — precisely the class of failure a 72-hour soak catches and a 10-minute test never
will), and **health-checks the runtime's own `/health`** rather than a synthetic ping.

Every target's `certification` field reads `pending-validation`.

## 9. Capability promotion workflow (deliverable 7)

`CAPABILITY_MATURITY.md` is a markdown table. Anyone can promote Fire Detection to `Production` by
typing the word, and nothing asks "on the strength of what?". Over a year that table drifts from a
record of evidence into a record of optimism.

So promotion becomes a **function**, taking report **ids** rather than claims:

```
Experimental → Beta        a real-footage evaluation that passed
Beta         → Production  + hardware evidence: a certified compatibility run,
                             a passed soak, a benchmark that did not regress
anything     → Deprecated  a named successor (deprecating with nowhere to go
                             strands whoever is using it)
```

- **An id proves a run happened, not that it succeeded** — hence `certification_status`, `soak_passed`,
  `benchmark_accepted`. Citing a failed run would otherwise look identical to citing a passing one.
- **Every blocker is reported at once.** An engineer who has to run the gate five times to discover
  five blockers stops running the gate.
- **Demotion needs no evidence.** Discovering that something is worse than believed must never be
  harder than claiming it is better; a gate that makes demotion expensive keeps bad capabilities
  promoted.
- **A refusal is still recorded in the history** — the record you want when someone asks in six months
  why Fire Detection is still Experimental.

## 10. Customer validation package (deliverable 8)

One bundle a customer returns after a pilot: summary, compatibility, capability, soak, benchmarks,
redacted configuration, health, recovery analytics, log excerpt.

**`configuration` passes through `redact_config()` unconditionally.** A validation bundle travels by
email between organisations, and the single worst outcome of this milestone would be a camera password
making that journey. Redaction is deep, catches secret-ish keys case-insensitively
(`rtspPassword`, `X-Auth-Token`, `credential_ref`), and routes URIs through the _same_ `redact_uri()`
the runtime's logs use — so the bundle and the logs can never disagree about what a credential looks
like.

## 11. Hardware sizing (recommendation 2)

Sizing reuses `ComputeRegistry.unit_cost()` — the same arithmetic admission control uses. There is no
second set of numbers to drift.

- **Unmeasured recommendations are marked `estimated: true`** and say "not measured" in their rationale,
  so nobody quotes a catalogue default to a customer as if it were a measurement. With a
  `BenchmarkReport` supplied, `estimated` becomes false and `basis` names the report.
- **A box that fell short of its benchmark target costs more per camera** (5 fps requested, 3 achieved →
  5/3 the cost). Ignoring that is how a site gets sized on a benchmark it never met.
- **30% headroom is required, not preferred.** A box sized to 100% has no room for the reconnect storm
  after a site power cut, when every camera comes back at once and the system is least able to cope. A
  class that only fits at 95% is reported as **infeasible**, not as a tight fit.
- **Smallest-that-fits, not largest-available.** Over-specifying is a real cost to a customer buying
  forty sites.
- **A developer laptop is never recommended** unless it is the only class allowed.

## 12. CCTV dataset library (priorities 1 & 3)

Eighteen scenario directories under `ai/datasets/`, each with a README stating what the scenario is,
what the runtime produces today, and — the section that matters — **the honest gap**:

> `abandoned_object`: "Requires object permanence the current tracker does not model. This is a
> capability gap, not a tuning gap."
>
> `cashier_theft`: "Without POS-transaction correlation this is guesswork. The corpus should record
> that limit rather than pretend otherwise."
>
> `suspicious_behavior`: "The vaguest category in the corpus, and the one most likely to encode bias.
> Every case must state exactly what a human saw, in behavioural terms."

**Footage bytes never enter git.** Each `footage/` directory carries a `.gitignore` that refuses
everything but `.dvc` pointers. Surveillance footage of real people is not something a repository
should carry around forever, and a clip committed by accident cannot be un-committed from everyone's
clone. Every case must record a **licence or consent basis**; the manifest refuses to load without one.

**Design decisions:**

- **The category list is a closed enum.** An open string would let cases accumulate under three
  spellings of "loitering" and quietly stop being a regression suite — the failure mode of every test
  corpus allowed to grow organically.
- **The directory is the source of truth.** A case declaring `queue` while living under `loitering/`
  is refused at load, or `--category queue` silently misses it.
- **Expectations are temporal and countable, not pixel-exact.** The platform's job is to notice that
  someone dwelt near the counter between 0:12 and 0:31. Holding it to a bounding-box IoU it was never
  labelled for would make the corpus expensive to maintain and dishonest about what it proves.
- **Negative expectations are first-class.** In surveillance analytics a false positive costs more than
  a miss: an operator paged four times a night for nothing stops reading the alerts by Thursday, and
  then the misses stop mattering too. Two of the three template cases are primarily negative.
- **A behaviour spanning 400 frames is one occurrence.** A 19-second loiter emits a `BehaviorResult`
  every frame; counting those as 190 loiterings would make every temporal expectation meaningless.
- **Incident expectations are `deferred`, not scored.** A case describes what the _whole platform_
  should make of a clip, including the incident a rule would raise — but the AI runtime emits events,
  not incidents, and scoring itself against an output it does not own would be meaningless in both
  directions.
- **`footage-missing` is never a pass.** In CI, where the DVC bytes are not pulled, every case reports
  skipped and `accepted` is false. A suite that goes green because it evaluated nothing is worse than
  no suite; `summarize()` requires that at least one case was actually evaluated.

Three template cases ship (loitering, queue, shoplifting). They load, and they report
`footage-missing` — which is the correct answer and demonstrates the mechanism.

## 13. AI Playground as the workbench (priority 2)

Five new artifacts alongside the existing six:

| artifact           | what it answers                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeline.json`    | **"what happened, in order?"** — one chronological stream across detection → track → behaviour → composite → event, ordered so reading order matches causality. Correlating that by hand across four JSON files is the most tedious thing about debugging a video |
| `incidents.json`   | incident **candidates**, explicitly labelled: the runtime emits events; the rules service decides what is an incident                                                                                                                                             |
| `evidence.json`    | the manifest of what _would_ be captured — clip window, frames, correlation ids — with `status: not-registered` always                                                                                                                                            |
| `performance.json` | stage timings as a **cost breakdown**; raw milliseconds are hard to act on, share-of-total is not                                                                                                                                                                 |
| `report.html`      | a self-contained page putting the annotated video next to the timeline that explains it                                                                                                                                                                           |

`report.html` has **no CDN, no framework, no script tag**: it opens from a filesystem on a laptop with
no network, which is what a customer demonstration tends to be. Text is escaped — identifiers reach the
page from configuration and from model label maps, both external data, and a demonstration page that
renders them raw is an XSS the moment it is shared.

The timeline records **lifecycle changes, not frames**. A confirmed track present for 400 frames is one
entry, not 400, or everything else is buried.

## 14. What AI-5e deliberately did NOT do

- **No architectural expansion.** No new service, no new runtime layer, no new perception capability.
  The certification harness is an **observer** of the frozen runtime;
  `test_production_certification.py::AdditivityTest` asserts a session runs identically with and
  without one.
- **No changes to the five frozen contracts.** `DetectionResult` → `Track` → `BehaviorResult` →
  `CompositeBehavior` → `EventEnvelope` are untouched. Everything added is operational/governance and
  additive; `CameraCapabilities` gained one optional defaulted field (`metadataStream`).
- **No hardware compatibility claim.** Every device is `Pending Validation`. Every packaging target is
  `pending-validation`. No capability was promoted.
- **No accuracy claim.** The corpus ships three template cases and no footage. Precision and recall are
  `n/a`, not `0`.

## 15. Gates

| gate                     | result               |
| ------------------------ | -------------------- |
| Contract tests           | **243** (+30)        |
| JSON schemas             | **123** (+19 AI-5e)  |
| Python tests             | **774** (+230 AI-5e) |
| Production scenarios     | 17/17                |
| Typecheck · lint · build | clean                |
| Import-graph             | 0 violations         |
| AI-5a baseline           | PASS, 0.00% dropped  |

## 16. What real hardware must now do

The framework is complete and it is waiting. When the Architect has a camera:

```bash
# 1. find it
python ai/inference/certify_cli.py --discover

# 2. certify it (credentials from the environment, never argv)
export VIP_CAMERA_USERNAME=admin VIP_CAMERA_PASSWORD=…
python ai/inference/certify_cli.py --target hikvision-generic --source rtsp \
  --uri "rtsp://cam.local:554/Streaming/Channels/102" \
  --deployment mini-pc-i5 --min-fps 5 --max-loss 1 \
  --soak-hours 24 --write-registry --output cert-out

# 3. the matrix changes only then
python ai/inference/certify_cli.py --matrix
```

Two checks will remain `not-executed` until a person performs them: **`reconnect-recovery`** (a
deliberate link interruption) and **`clean-shutdown`** (a full teardown observation). Both block
certification by design, and both are supplied through `harness.record()` when measured.

**Until that happens, this milestone claims exactly one thing: that the procedure exists, is
reproducible, and refuses to certify anything it has not measured.**
