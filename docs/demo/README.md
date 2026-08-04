# Demo Gallery

> **Real artefacts from the running product, collected as each feature lands.**

Every clip and screenshot here was recorded against the **production deployment** — built images,
served through the edge, signed in as a real demo account, driving the real API. Nothing is mocked,
staged, sped up, or reconstructed afterwards.

---

## Why it is built continuously rather than at the end

A demo library assembled the week before a customer meeting is assembled from whatever happens to
work that week. Recording each feature **as it lands** makes the gallery a by-product of the
milestone instead of a project of its own — and it turns a workflow that has quietly stopped working
into a clip that fails to record, months before anyone would meet it in front of a customer.

By **P-10 · Pilot Proven** this should already be the material for demonstrations, onboarding,
documentation and training, without a scramble.

## Three rules

- ⚠️ **A clip is not a claim.** Every page below carries the feature's **known limitations** beside
  its recording. A demonstration that omits them is the most expensive kind of promise, and this
  product's whole discipline is that the limits are stated before a customer finds them.
- ⚠️ **Never record what the platform cannot do.** No fixture dressed as live data, no cut between a
  click and a result that did not follow it, no speed-up hiding a slow path. The recorder inserts
  pauses so a viewer can follow a click; it never removes one.
- ⚠️ **The interesting clip is not the one where everything is green.** System Health is recorded
  with object storage being taken away underneath it, because that is the claim the feature makes.

## What is here

| Feature                                     | Milestone | Shows                                                                 |
| ------------------------------------------- | --------- | --------------------------------------------------------------------- |
| [System Health](system-health/)             | P-6.4     | Truthful operational state — including a dependency failing, live     |
| [Tenant Settings](tenant-settings/)         | P-6.3     | Organisation identity, validation, optimistic concurrency, branding   |
| [User administration](user-administration/) | P-6.2     | Creating, re-roling and disabling an operator; sessions ended at once |
| [Rule editing](rule-editing/)               | P-6.1     | Authoring and versioning a detection rule                             |

Still to come, in the milestone that builds them: the notification centre (P-6.5), camera management
depth, the media catalogue, live video (P-8), hardware validation (P-9), AI recommendations.

## Producing it

```sh
# Playwright is not a repo dependency; run from a directory that has it.
cd /private/tmp/pwrun && OUT=<repo>/docs/demo node <repo>/docs/demo/record.mjs [feature…]
```

[`record.mjs`](record.mjs) drives each workflow and writes `<feature>/<feature>.webm`. WebM because
Playwright records it natively and every browser plays it; there is no `ffmpeg` in this toolchain,
and a GIF of a thirty-second workflow is several megabytes of repository for a worse picture.

⚠️ **Screenshots are not duplicated here.** They live with the verification that produced them, under
[`docs/review/`](../review/), and each page below links to them — one artefact, one home.

⚠️ The recorder **restores whatever it touches**: the tenant name it edits is put back, the dialogs
it opens are cancelled rather than confirmed, and the container it stops is started again. A gallery
that left the demo dataset changed would be a gallery that broke the next demonstration.

## Related

- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — the source for every "what this does not do"
- [PRODUCT_CAPABILITY_MATRIX](../project/PRODUCT_CAPABILITY_MATRIX.md) — what is demo-ready today
- [CUSTOMER_JOURNEYS](../project/CUSTOMER_JOURNEYS.md) — the narratives these clips sit inside
