# P-6.5 · Lessons

> **Not a defect list.** The defects are recorded in the [review package](README.md) and the
> [verification matrix](VERIFICATION_MATRIX.md). This is what the milestone taught about how work is
> verified, written so a later milestone inherits the lesson without inheriting the incident.
>
> Each entry: **why it escaped · what exposed it · the rule that prevents it · whether it belongs in
> the Definition of Done · what the verification framework gained.**

---

## 1 · A rule that must hold under concurrency has to be enforced where the concurrency is

**Why it escaped.** The test double serialises everything. Written against it, a rule that decides an
outcome by reading first and writing second looks atomic, and the test passes _because_ the fake is
faithful to everything except the one property under test. The suite was green, thorough, and blind.

**What exposed it.** Running the same scenario against the real store, from independent connections,
repeatedly. Not once — the first round passed against the defect.

**The rule.** Any transition whose correctness depends on _exclusivity_ is proven against the real
dependency, concurrently, over enough rounds that a single lucky ordering cannot carry it. And the
regression test is written **red first** against the defect, or it is not evidence.

**Definition of Done:** yes — added.

**The framework gained** a rule it now applies to itself: a concurrency test must first prove the
requests overlapped. A test that cannot show it was concurrent is a spelling test.

---

## 2 · Demonstration data is a claim about the product

**Why it escaped.** A fixture was written from what the feature was _meant_ to do rather than from
what the platform _does_, and it read plausibly. Nothing compares a fixture to the behaviour it
describes, so it survived every review — including the ones that looked straight at it.

**What exposed it.** Measuring the real path end to end and asserting the measured value, which
disagreed with the fixture.

**The rule.** A fixture value that describes platform behaviour must be **measured from the platform**
and pinned by a check that goes red when the behaviour changes. ⚠️ The check asserts the truth, not
the aspiration: the day the behaviour arrives, somebody has to come and change the claim deliberately.

**Definition of Done:** yes — added.

**The framework gained** the habit of pointing verification at the _customer-facing_ path rather than
the developer one. The fabrication came back after it was fixed, because the reset a salesperson runs
went through a different path from the one the fix was tested on (§5).

---

## 3 · An error message is part of the product, and is judged by what the reader can do next

**Why it escaped.** The exit criterion was "the failure is visible with its reason", and a message
was present. Presence was checked; usefulness was not. A message that names the library's internal
failure satisfies every automated check and tells the person on shift nothing.

**What exposed it.** Reading the screen as an operator — and then encoding that reading as an
assertion on the exact words, against a real far end that really refuses, really hangs, and really
cannot be resolved.

**The rule.** Any string a person will act on is asserted **verbatim** against a real counterpart, and
the assertion includes what it must _not_ say.

**Definition of Done:** yes — added.

---

## 4 · A fix has the scope of the pattern, not the scope of the page it was found on

**Why it escaped.** A defect was found on one screen, fixed there, and closed. The same shape existed
on the screen next to it, built from the same shared component, and nobody asked the question a second
time. The second screen was the more important one.

**What exposed it.** Taking the deployment apart while _both_ screens were open, instead of the one
the defect had been reported against.

**The rule.** When a defect is found in a shared pattern, the unit of repair is the **pattern**, and
the verification enumerates every place it is used. "Fixed on the page where it was reported" is a
status, not a fix.

**Definition of Done:** yes — added.

---

## 5 · Two true sentences can leave a false impression

**Why it escaped.** The wording had already been corrected once, from a version that read like a
failure to one that read like success. Each clause was accurate. Nobody asked what the _pair_ of
them left two people believing at the same moment — which was that each of them, alone, was handling
the incident.

**What exposed it.** A screenshot assertion added an hour earlier at the freeze, checking that a
picture contained the state its filename claimed. It caught a product defect while checking a file.

**The rule.** Messages are judged by **what the reader concludes**, not by whether each clause is
true — and where two people can act on the same object, the message has to account for the other
person. Where a conclusion matters, assert on the conclusion.

**Definition of Done:** no — this is judgement, not procedure. It belongs in review, and the reviewer
asks: _what does this leave the reader believing, and is that true?_

**The framework gained** the discipline that **evidence must assert its own content**. A capture
script that writes files without checking what is in them can only pass; eight screenshots were being
produced with nothing verifying that any of them showed what its name claimed.

---

## 6 · The deployment is not the commit until that has been measured

**Why it escaped.** Everything that gets restarted, health-checked and verified stays current on its
own. What escaped was the one component nothing restarts: a tool that runs on demand, out of an image
built for something else, only ever executed right before somebody demonstrates the product. Correct
source, committed fix, tests green, and the wrong bytes running.

**What exposed it.** Comparing the compiled artefacts inside every image against a build of the
working tree, file by file.

**The rule.** Before a verification run is allowed to mean anything, **prove the deployment is the
commit** — every service, every shared package, the browser bundle the edge actually serves, and the
tools that are not services. Record the hash in the report.

**Definition of Done:** yes — added, as the first step of the gate rather than the last.

**The framework gained** `deployment-integrity.mjs`, which needed no mutation to prove it works: it
went red on three real states the first time it ran.

---

## 7 · A check that has never failed has not been verified

Four shapes, found in one milestone's own tooling:

- **Checks that cannot fail** — a tautology, a comparison of two empty strings, arithmetic that
  measures a page size rather than a set, a plan for a query the script wrote itself. They report
  success for ever and nobody looks again.
- **Checks that cannot pass** — an expectation naming a row that does not exist, a value read after
  the element carrying it has gone, a reader taking text from the wrong element, a locator matching
  by words where the words repeat. These are less dangerous and more expensive: they send somebody
  hunting a defect in a product that is behaving.
- **Checks that pass for the wrong reason** — a probe whose evidence a _previous_ run left behind, a
  fixture whose absence turned nine attempts into a footnote under checks that all passed. Green, and
  measuring something other than what the label says.
- **Checks that never ran** — a crash after the early assertions, reported as an ordinary non-zero
  exit. Five later checks did not execute and nothing in the output said so.

**Why they escape.** A green check and a check that measures nothing are indistinguishable from the
outside. Nothing in a passing run distinguishes them.

**What exposed them.** Deliberately breaking the behaviour and confirming the red — and, for two of
them, simply reading the code with the question _what would make this fail?_

**The rule.** ⚠️ **Every verification script is mutation-tested in the milestone that introduces it.**
Break the behaviour it claims, confirm it goes red on the owning check with a message that names the
fault, restore, confirm green. Assertion-flipping is not evidence: mutate the **product**.

**Definition of Done:** yes — added.

**The framework gained** the habit of recording, next to each script, _what a mutation could not
reach_ — the limits of what it is entitled to claim.

---

## 8 · Silence is not success

The same shape, found four times in one milestone, in four unrelated places: an integration suite
excluded from the default test command; a suite that skips itself when its dependency is unreachable;
a long-running script that crashed _after_ its early checks and skipped five later ones while
reporting a non-zero exit that looked like an ordinary failure; and a fixture that a container
rebuild deleted, after which every attempt to use it failed and was counted in a footnote under
checks that all passed.

**The rule.** A run reports what it **did not** do as loudly as what it did. Absence — skipped,
excluded, crashed, unavailable — is a finding, not a gap in the output. And any fixture a run depends
on is installed **by that run**, never assumed to have survived.

**Definition of Done:** yes — added.

---

## What this milestone changed about how verification is written

| Before                                      | Now                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Scripts were trusted once they passed       | A script is trusted once it has **failed for the correct reason** and been restored        |
| The deployment was assumed to be the commit | The deployment is **proven** to be the commit, and the hash is in the report               |
| Evidence was captured                       | Evidence **asserts its own content** — a screenshot must contain the state it is named for |
| Fixtures were assumed present               | Fixtures are installed by the run that needs them                                          |
| A check's claim was its label               | A check's claim is its label **plus** what a mutation showed it cannot see                 |
| Concurrency was tested                      | Concurrency is tested **and the overlap is proven** before the result is believed          |
