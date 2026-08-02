# Index Policy

**Mandatory reading before adding a database index — or a query that needs one.**

Status: permanent · Established P-3 Hardening · Recorded 2026-08-02.

---

The rule this document exists for:

> **An index is not coverage until a query plan says so.**
> "We created indexes" and "the planner will use them" are different claims. Only the second one
> survives production, and only the second one is worth asserting.

The P-3 review asked for the second claim and got three defects in return — reads whose _filter_ was
indexed and whose _sort_ was not, each a blocking in-memory sort, each completely invisible against a
test fixture. None had been caught by review. That is the failure mode this policy prevents.
(CONSTRAINTS §40.)

---

## 1. Naming

`<scope>_<discriminator>[_<discriminator>]`

| Name                 | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| `tenant_zone`        | tenant-scoped, discriminated by zone                   |
| `tenant_path_depth`  | tenant-scoped, by path, ordered by depth               |
| `tenant_cursor`      | tenant-scoped, cursor only — the unfiltered paged read |
| `uniq_tenant_stream` | a uniqueness constraint, not an access path            |
| `_id_`               | MongoDB's implicit index. Never created by us.         |

Prefix `uniq_` when the index exists to **forbid** something rather than to **find** something. The
two have different reasons to exist and different reasons to be removed.

## 2. Compound ordering — the only rule that matters

**Equality → Sort → Range.** In that order, always.

```
{ tenantId: 1,   zoneId: 1,        _id: 1        }
   ^equality      ^equality          ^sort + cursor range
```

The planner consumes an index left to right:

1. **Equality keys** must occupy a _contiguous prefix_. A gap ends the usable prefix — everything
   after it becomes a residual filter applied to whatever the prefix returned.
2. **The sort key must be the next key.** Not "somewhere in the index". _Next._ If it is not, the
   planner fetches every match and orders it in memory.
3. **A range on the sort key is free** — that is what a cursor is. `_id: {$gt: c}` sorted by `_id` is
   a seek followed by a walk, the most index-friendly shape there is.

### Every index ends in the cursor key

Every bounded read in this platform pages by an `_id` cursor. An index that stops at the filter key
serves the filter and abandons the sort:

| Index                     | `find({tenantId, zoneId}).sort({_id})` |
| ------------------------- | -------------------------------------- |
| `{tenantId, zoneId}`      | ❌ fetch all matches, sort in memory   |
| `{tenantId, zoneId, _id}` | ✅ walk the range, already ordered     |

On four fixture rows both are instant. On a million cameras the first is a blocking sort against
MongoDB's 32 MB limit. **This is the single most common way an index looks right and is not.**

## 3. Filter first, sort second

State every query as `(equality keys, sort key, range keys)` _before_ choosing an index. If you cannot
write that triple, the query is not understood well enough to index.

Then check the triple against the index rules above. The check is mechanical — which is why it is a
test rather than a review comment.

## 4. Covering indexes

An index _covers_ a query when it contains every field the query reads, so the document is never
fetched. Worth it for hot, narrow projections; rarely worth it here, because our reads return whole
records and a covering index for a whole record is a second copy of the collection.

**Do not chase covered queries.** Chase served sorts. The sort is where the cliff is.

## 5. When to create an index

- A query the service **actually issues** has no covering index. (The coverage test tells you.)
- A uniqueness constraint the domain requires.
- A new bounded read — added in the same commit as the read, never after.

**Every index leads with `tenantId`** (Law 5). A tenant-leading index makes a cross-tenant range scan
structurally impossible, which matters more than the marginal selectivity of any other leading key.
The sole exception is MongoDB's `_id_`, which is unique — a match is a single document, checked
against the scope guard before it is returned.

## 6. When NOT to create an index

- **For a query nobody issues.** Speculative indexes are write cost, disk and planner noise bought
  against a guess. `health.status` and `lastSeen` are filtered console-side over an already-bounded
  page; there is no server query, so there is no index.
- **When an existing index's prefix already serves it.** `{tenantId, zoneId, _id}` serves
  `{tenantId}`, `{tenantId, zoneId}` and both with an `_id` cursor. Three indexes would be one index
  and two liabilities.
- **For an unanchored substring search.** No B-tree serves `/foo/`. Either anchor it (`/^foo/`, which
  `{tenantId, name, _id}` does serve) or accept the scan and bound it — do not add an index that will
  not be used and will imply it was.
- **To make a slow query survivable when the query is wrong.** An unbounded read wants a limit, not an
  index.

## 7. Write-cost trade-offs

Every index is paid for on **every insert and every update touching its keys**:

- an extra B-tree write per index per document;
- more WiredTiger cache pressure — indexes compete with documents for RAM, and an index that does not
  fit is a disk read per lookup;
- longer index builds and larger backups.

The camera collection is write-heavy (probes, health, lifecycle transitions). Seven indexes there is a
considered number, not a floor. **Multikey indexes are the expensive case**: `{tenantId, path, _id}`
stores one entry _per array element_, so a node at depth 7 writes seven index entries. That is
affordable precisely because containment bounds depth at 7 — an unbounded hierarchy would make the
same index unbounded per document.

## 8. How this is enforced

Index specifications are declared as **data**, not as a sequence of `createIndex` calls:

- `services/tenant/src/adapters/indexes.ts`
- `services/camera/src/adapters/indexes.ts`

Each carries its keys and a `serves:` line saying which query it exists for — so a later reader can
tell whether it is still needed. `ensureIndexes` iterates the declarations, so the code and the
documentation cannot drift.

`index-coverage.test.ts` in each service transcribes every query the service issues and asserts a
covering index exists under the rules in §2. **It fails when a query pattern is added without one.**
The model's own edge cases are tested too — an early version treated "the sort field is also filtered"
as sufficient, which would have declared one of the three real defects covered. A coverage check that
wants to pass is worse than none: it converts an open question into a false answer.

## 9. Adding a query — the checklist

1. Write the triple: equality keys, sort key, range keys.
2. Check §2. Does an existing index's prefix serve it?
3. If yes — add the query to `index-coverage.test.ts` and stop. No new index.
4. If no — add the spec with a `serves:` line, add the query to the test, and note the write cost if
   the collection is write-heavy.
5. If the query cannot be served (unanchored search) — say so in the test, with the mitigation.

## Related

- [CONSTRAINTS §40](CONSTRAINTS.md) — the enforceable rule.
- [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) — the ten rules the platform is built on.
- [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md) — the index coverage report.
- [ED-0053](ENGINEERING_DECISION_LOG.md) — the review that produced this policy.
