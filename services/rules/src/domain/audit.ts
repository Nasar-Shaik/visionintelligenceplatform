/**
 * Domain: **what happened to a rule, in operational words** (P-4.1, Architect rec 12).
 *
 * The Architect asked for a lifecycle audit trail. The platform already has one — it just does not read
 * like one. Every change to a rule since P1-7 has produced an immutable `RuleVersionRecord` holding a
 * full snapshot, so "when was this enabled, and by whom" is already recorded; it is simply recorded as
 * a sequence of states rather than a sequence of events.
 *
 * So this module **derives** the narrative instead of writing a second one. Three reasons, in order of
 * how much trouble each avoids:
 *
 * 1. **Two records of one truth eventually disagree.** A parallel audit collection is written by a
 *    different code path from the versions; the first bug in either makes the history and the audit
 *    tell different stories, and there is no principled way to decide which lied.
 * 2. **A derived trail works retroactively.** Rules authored a year before anyone thought about audit
 *    actions get the same timeline as one authored today.
 * 3. **It is [Foundation Principle 2](../../../../docs/project/FOUNDATION_PRINCIPLES.md)** — persist
 *    measurements, derive conclusions. The versions are the measurement.
 *
 * `rolled-back` is derived the same way: a version whose content hash equals an earlier version's is a
 * return to that version. That is what a rollback *is*, and deriving it means it is detected however it
 * happened — through the rollback endpoint, through an operator re-pasting an old body, or through a
 * script. An intent flag would only have recorded the first.
 *
 * Pure.
 */
import type { Rule, RuleAuditAction, RuleAuditEntry, RuleVersionRecord } from '@vip/contracts';
import { contentHash } from './fingerprint.js';

/** Top-level rule fields worth naming in a timeline. Bookkeeping is excluded — it always changes. */
const TRACKED_FIELDS = [
  'name',
  'description',
  'priority',
  'eventTypes',
  'categories',
  'condition',
  'window',
  'severity',
  'actions',
  'scope',
  'resolvedScope',
  'lifecycle',
] as const;

function changedFields(previous: Rule, current: Rule): string[] {
  const changed: string[] = [];
  for (const field of TRACKED_FIELDS) {
    const before = JSON.stringify(previous[field] ?? null);
    const after = JSON.stringify(current[field] ?? null);
    if (before !== after) changed.push(field);
  }
  return changed;
}

/** The lifecycle action a transition represents, or undefined when the state did not move. */
function lifecycleAction(previous: Rule, current: Rule): RuleAuditAction | undefined {
  if (previous.lifecycle === current.lifecycle) return undefined;
  if (current.lifecycle === 'enabled') return 'enabled';
  if (current.lifecycle === 'disabled') return 'disabled';
  if (current.lifecycle === 'archived') return 'archived';
  // Out of `archived` into anything else is a restoration; every other move is authoring progress.
  return previous.lifecycle === 'archived' ? 'restored' : 'updated';
}

function summarize(action: RuleAuditAction, fields: string[], restoredFrom?: number): string {
  switch (action) {
    case 'created':
      return 'the rule was created';
    case 'deleted':
      return 'the rule was deleted';
    case 'enabled':
      return 'the rule was enabled and is now evaluated against live events';
    case 'disabled':
      return 'the rule was disabled and is no longer evaluated';
    case 'archived':
      return 'the rule was archived';
    case 'restored':
      return 'the rule was restored from the archive';
    case 'rolled-back':
      return `the rule was rolled back to the content of version ${restoredFrom}`;
    default:
      return fields.length > 0
        ? `changed ${fields.join(', ')}`
        : 'the rule was saved with no effective change';
  }
}

/**
 * Turn a rule's version history into a timeline.
 *
 * Input order does not matter — `listVersions` returns newest first, which is right for a list and
 * wrong for deriving transitions, so this sorts rather than trusting.
 */
export function deriveAudit(versions: readonly RuleVersionRecord[]): RuleAuditEntry[] {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const hashes = new Map<number, string>();
  const entries: RuleAuditEntry[] = [];

  for (const [index, record] of ordered.entries()) {
    const current = record.snapshot;
    const hash = contentHash(current);
    const previous = index > 0 ? ordered[index - 1]!.snapshot : undefined;

    let action: RuleAuditAction;
    let restoredFrom: number | undefined;
    let fields: string[] = [];

    if (record.changeKind === 'created' || !previous) {
      action = 'created';
    } else if (record.changeKind === 'deleted') {
      action = 'deleted';
    } else {
      fields = changedFields(previous, current);
      const transition = lifecycleAction(previous, current);
      if (transition) {
        action = transition;
      } else {
        /*
         * A rollback restores an *earlier* version's content. The immediately preceding version is
         * excluded on purpose: matching it means nothing behavioural changed at all (a rename, say),
         * which is an edit, not a rollback.
         */
        const match = [...hashes.entries()].find(
          ([version, earlier]) => earlier === hash && version !== previous.version,
        );
        if (match) {
          action = 'rolled-back';
          restoredFrom = match[0];
        } else {
          action = 'updated';
        }
      }
    }

    hashes.set(record.version, hash);
    const entry: RuleAuditEntry = {
      ruleId: record.ruleId,
      version: record.version,
      action,
      summary: summarize(action, fields, restoredFrom),
      changedFields: fields,
      at: record.changedAt,
      contentHash: hash,
    };
    if (restoredFrom !== undefined) entry.restoredFrom = restoredFrom;
    if (record.changedBy !== undefined) entry.actor = record.changedBy;
    entries.push(entry);
  }

  // Newest first — a timeline is read from the top, and that is also how `listVersions` returns.
  return entries.reverse();
}
