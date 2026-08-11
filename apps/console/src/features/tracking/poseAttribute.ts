/**
 * `Track.attributes.pose` → a typed skeleton, or `null`.
 *
 * ⚠️ **Defensive on purpose.** `attributes` is `Record<string, unknown>` by contract — the runtime
 * may attach anything a stage produced, and a console that trusts its shape renders `undefined` into
 * an SVG coordinate and draws a limb at the origin. Every field is checked; anything unrecognised
 * yields `null`, which the overlay renders as *nothing at all* rather than as a plausible skeleton.
 */
import type { PoseKeypoint } from '@/ui';

/** What the runtime attaches: `pose.to_attribute` in `ai/inference/pose.py`. */
export interface PoseAttribute {
  skeleton: string;
  model: string;
  artifactSha256: string;
  threshold: number;
  /** The runtime's own words for what `visible` means; shown verbatim, never paraphrased. */
  visibleMeaning: string;
  keypoints: PoseKeypoint[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function keypoint(raw: unknown): PoseKeypoint | null {
  if (!isRecord(raw)) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  const confidence = num(raw.confidence);
  if (typeof raw.name !== 'string' || x === null || y === null || confidence === null) return null;
  // ⛔ `visible` is only ever the runtime's boolean. Deriving it here from `confidence` would put a
  // second, console-side visibility rule beside the runtime's — two answers to one question, and
  // the one on screen would be the one nobody reviewed.
  if (typeof raw.visible !== 'boolean') return null;
  return { name: raw.name, x, y, confidence, visible: raw.visible };
}

export function parsePose(attributes: Record<string, unknown> | undefined): PoseAttribute | null {
  const raw = attributes?.pose;
  if (!isRecord(raw) || !Array.isArray(raw.keypoints)) return null;
  const keypoints = raw.keypoints.map(keypoint).filter((k): k is PoseKeypoint => k !== null);
  if (keypoints.length === 0) return null;
  return {
    skeleton: typeof raw.skeleton === 'string' ? raw.skeleton : 'unknown',
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    artifactSha256: typeof raw.artifactSha256 === 'string' ? raw.artifactSha256 : '',
    threshold: num(raw.threshold) ?? 0,
    visibleMeaning: typeof raw.visibleMeaning === 'string' ? raw.visibleMeaning : '',
    keypoints,
  };
}
