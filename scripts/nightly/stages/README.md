# Nightly stages

One file here is one stage. The engine (`../engine.sh`) reads a profile, finds `stages/<script>`,
runs it as a child process, and records what it returned. That is the whole contract — which is why
adding a capability adds files here and rows in a profile, and never touches the engine.

## The folder is the domain

```
stages/
  _preamble.sh          shared stage contract — sourced first by every stage
  platform/             the deployment as a whole, independent of any one capability
  runtime/              the perception runtime: inference, its dashboard, its capacity
  tracking/             object tracking: identities, their pages, their capacity
  events/               the event platform: the chain end to end, determinism, its page
  publisher/            the producer seam: what publishing costs, and whether its checks bite
  broker/               the transport: what happens when it goes away and comes back
```

⚠️ **The Event Bridge is three folders, not one, and that is the same rule applied.** It spans a
producer in `services/media`, a consumer in `services/events`, and a broker neither of them owns —
and they fail independently. A broker outage is not an events-service bug, and a publisher that
sheds load under pressure is behaving correctly while the broker is fine. One `bridge/` folder would
put a stage that stops NATS for the whole platform next to a stage that reads a page, and the night
would have no way to say which of the two an operator needs to care about.

⚠️ **The domain is not the same thing as the check type.** `runtime/benchmark.sh` and
`tracking/benchmark.sh` are both benchmarks and they are deliberately separate files, because what
they measure diverges: frames per second and dropped frames on one side, identity stability and lost
tracks on the other. Grouping by check type instead would produce one `benchmark.sh` that grows a
branch per capability, and the first thing a new capability would have to do is edit a file every
other capability depends on.

**Reserved, in the order the roadmap expects them.** Each is a folder that does not exist yet, and
creating one is the whole cost of adding its verification:

| Folder                             | Arrives with                 | Verifies                                                    |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `incidents/`                       | incident lifecycle           | acknowledgement, audit history, evidence linkage            |
| `camera-assignment/`               | selective AI processing      | which cameras are analysed, and that the answer is enforced |
| `analytics/`                       | counting and dwell reporting | aggregates match the tracks they were derived from          |
| `retail/` `warehouse/` `hospital/` | vertical packs               | the journeys that vertical sells, end to end                |

⚠️ **`rules/` is deliberately gone from this list, and not because it arrived.** The rule engine has
existed and been frozen since P1-7; what was missing was anything publishing to it, which is what
`events/bridge.sh` now covers end to end. A reserved folder for something already built is a row
that reads as a gap, and someone would eventually build a second rule engine to fill it. When rules
grow their own verification — authoring, versioning, simulation over stored history — they get the
folder then.

A vertical folder verifies **journeys**, not new primitives. If a vertical needs a new primitive, the
primitive gets its own domain folder and the vertical consumes it — otherwise the same check ends up
implemented three times and drifts twice.

## Writing a stage

```sh
#!/usr/bin/env bash
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

ok   "something that held"
bad  "something that did not"      # non-zero exit; the night continues
note "context for the log"
headline "one line the morning summary shows"
finish
```

⚠️ **The preamble is found through `$STAGES_DIR`, not through `dirname $0`.** The self-test runs
synthetic stages from a temporary flat directory, and a relative `../_preamble.sh` would resolve
differently there than in the real tree — so the failure semantics would be proven against a layout
that never runs at 03:00.

Also available: `guard`/`unguard` (register an undo command the engine runs if the stage is killed),
`metrics_path` (write JSON for the report to read), `warn`.

⚠️ **A stage must not write to a tracked file.** Every underlying script takes `OUT=` and is pointed
into the run directory. This was found the hard way: three stages overwrote committed evidence, so
every night rewrote the repository it was verifying and tripped the deployment-integrity check that
asserts the tree is clean.
