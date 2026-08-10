/**
 * **How the closed behaviour vocabulary reads on a screen** (Phase 2.4 slice 2.8).
 *
 * ### ⛔ Presentation only. Nothing here decides anything.
 *
 * Every phrase below renames a fact the runtime already stated; none of them adds, combines or
 * interprets one. That boundary is what ADR-0052 protects, and it is easiest to breach here, in a
 * file that looks like copy: a label reading "suspicious dwell" would put an accusation on a screen
 * that no layer of the platform is willing to sign, and it would arrive without a single line of
 * logic being written.
 *
 * ⚠️ **Unknown kinds render as themselves, never as "other".** The vocabulary is closed and checked
 * across languages (`perception-boundary.mjs` §H), so a kind arriving here that this table does not
 * know is a real deployment mismatch — showing its raw name puts that on screen instead of hiding it
 * behind a bucket that reads as "nothing much".
 */

/** The one-word noun for each timeline kind, as an operator reads it. */
const TIMELINE_LABELS: Record<string, string> = {
  observed: 'Observed',
  gap: 'Gap in view',
  zoneVisit: 'In zone',
  zoneEntry: 'Entered zone',
  zoneExit: 'Left zone',
  proximity: 'Near',
  carried: 'Carried',
  handover: 'Handed over',
  idle: 'Idle',
  linger: 'Lingered',
  lineCross: 'Crossed line',
  follow: 'Followed',
  approach: 'Approached',
  recede: 'Moved away',
  groupMerge: 'Joined group',
  groupSplit: 'Left group',
  queue: 'In queue',
  picked: 'Picked up',
  dropped: 'Put down',
  objectMissing: 'Object out of view',
  objectReturned: 'Object back in view',
};

export function timelineKindLabel(kind: string): string {
  return TIMELINE_LABELS[kind] ?? kind;
}

/**
 * Which reading of the run a kind belongs to.
 *
 * ⚠️ **`presence` is not "unimportant".** `observed` and `gap` are the structural spine — where a
 * subject was in view at all — and a gap is often the interesting part of an investigation. They are
 * grouped separately because they are also the most numerous by an order of magnitude, so an
 * operator who wants the behaviour needs one control to set them aside, not twenty.
 */
export type KindGroup = 'presence' | 'place' | 'solo' | 'social' | 'object';

export const KIND_GROUPS: Record<KindGroup, { label: string; kinds: string[] }> = {
  presence: { label: 'Presence', kinds: ['observed', 'gap'] },
  place: { label: 'Places', kinds: ['zoneVisit', 'zoneEntry', 'zoneExit', 'lineCross'] },
  solo: { label: 'Alone', kinds: ['idle', 'linger'] },
  social: {
    label: 'With others',
    kinds: ['proximity', 'follow', 'approach', 'recede', 'groupMerge', 'groupSplit', 'queue'],
  },
  object: {
    label: 'Objects',
    kinds: ['carried', 'handover', 'picked', 'dropped', 'objectMissing', 'objectReturned'],
  },
};

export function groupOfKind(kind: string): KindGroup | undefined {
  for (const [group, entry] of Object.entries(KIND_GROUPS)) {
    if (entry.kinds.includes(kind)) return group as KindGroup;
  }
  return undefined;
}

/** Graph edge kinds, as a line on the diagram is described. */
const EDGE_LABELS: Record<string, string> = {
  visited: 'visited',
  crossed: 'crossed',
  carried: 'carried',
  picked: 'picked up',
  dropped: 'put down',
  wentMissing: 'went missing',
  returned: 'came back',
  handedOver: 'handed over',
  near: 'was near',
  followed: 'followed',
  approached: 'approached',
  receded: 'moved away from',
  member: 'was in',
};

export function edgeKindLabel(kind: string): string {
  return EDGE_LABELS[kind] ?? kind;
}

/**
 * Tailwind classes per node kind. ⚠️ Colour is a **second** channel: every node also carries its
 * kind as text, because a legend that only exists in hue is unreadable to a large minority of
 * operators and invisible in a printed report.
 */
export const NODE_STYLE: Record<string, { fill: string; text: string; ring: string }> = {
  identity: { fill: 'fill-brand/20', text: 'text-brand', ring: 'stroke-brand' },
  object: { fill: 'fill-amber-500/20', text: 'text-amber-500', ring: 'stroke-amber-500' },
  zone: { fill: 'fill-sky-500/20', text: 'text-sky-500', ring: 'stroke-sky-500' },
  group: { fill: 'fill-violet-500/20', text: 'text-violet-500', ring: 'stroke-violet-500' },
  line: { fill: 'fill-emerald-500/20', text: 'text-emerald-500', ring: 'stroke-emerald-500' },
};

export function nodeStyle(kind: string) {
  return (
    NODE_STYLE[kind] ?? { fill: 'fill-muted', text: 'text-muted-foreground', ring: 'stroke-border' }
  );
}

/**
 * The step kinds a behaviour rule may name — ⛔ **exactly the graph's own vocabulary**.
 *
 * ⚠️ Duplicated from `BehaviourStepKind` deliberately as a *display order* rather than imported as a
 * set: the contract is the authority on what is legal, and this is the order a composer offers them
 * in. A test asserts every entry here is a member of the contract enum, so the two cannot drift into
 * a step an operator can compose and the service will reject.
 */
export const STEP_KINDS = [
  'visited',
  'linger',
  'idle',
  'crossed',
  'near',
  'followed',
  'approached',
  'receded',
  'member',
  'carried',
  'picked',
  'dropped',
  'wentMissing',
  'returned',
  'handedOver',
] as const;

/** How a step reads in a composer, before any filter is added to it. */
const STEP_PHRASES: Record<string, string> = {
  visited: 'was inside a zone',
  linger: 'lingered',
  idle: 'stood still',
  crossed: 'crossed a line',
  near: 'was near someone',
  followed: 'followed someone',
  approached: 'moved towards someone',
  receded: 'moved away from someone',
  member: 'was in a group',
  carried: 'carried something',
  picked: 'picked something up',
  dropped: 'put something down',
  wentMissing: 'something went out of view',
  returned: 'something came back into view',
  handedOver: 'handed something over',
};

export function stepPhrase(kind: string): string {
  return STEP_PHRASES[kind] ?? kind;
}
