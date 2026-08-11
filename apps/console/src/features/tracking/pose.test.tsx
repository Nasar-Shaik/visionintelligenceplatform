/**
 * The skeleton renderer — P3.3b.
 *
 * ⛔ The load-bearing assertions are the ones about what is **not** drawn. A skeleton is the most
 * persuasive artefact this product renders; a limb drawn to a joint the model never localized is a
 * claim about a person's body that nothing in the pipeline made.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { POSE_EDGES, PoseOverlay, type PoseKeypoint } from '@/ui';
import { parsePose } from './poseAttribute';

const JOINTS = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];

function keypoints(overrides: Partial<Record<string, Partial<PoseKeypoint>>> = {}): PoseKeypoint[] {
  return JOINTS.map((name, i) => ({
    name,
    x: 0.3 + i * 0.01,
    y: 0.2 + i * 0.02,
    confidence: 0.9,
    visible: true,
    ...(overrides[name] ?? {}),
  }));
}

describe('PoseOverlay', () => {
  it('draws every visible joint', () => {
    render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: keypoints() }]} />);
    for (const name of JOINTS) {
      expect(screen.getByTestId(`joint-${name}`)).toBeInTheDocument();
    }
  });

  it('never draws a joint the model did not localize', () => {
    const kp = keypoints({ left_wrist: { visible: false, confidence: 0.11 } });
    render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: kp }]} />);
    expect(screen.queryByTestId('joint-left_wrist')).not.toBeInTheDocument();
    expect(screen.getByTestId('joint-right_wrist')).toBeInTheDocument();
  });

  it('drops a limb when either endpoint is invisible, and keeps the rest', () => {
    const kp = keypoints({ left_elbow: { visible: false } });
    render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: kp }]} />);
    expect(screen.queryByTestId('limb-left_shoulder-left_elbow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('limb-left_elbow-left_wrist')).not.toBeInTheDocument();
    expect(screen.getByTestId('limb-right_elbow-right_wrist')).toBeInTheDocument();
  });

  it('renders nothing at all for a skeleton with no visible joints', () => {
    const kp = keypoints(Object.fromEntries(JOINTS.map((n) => [n, { visible: false }])));
    const { container } = render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: kp }]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });

  it('places a joint at its normalized position, in percent of the frame', () => {
    const kp: PoseKeypoint[] = [{ name: 'nose', x: 0.25, y: 0.75, confidence: 0.9, visible: true }];
    render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: kp }]} />);
    const joint = screen.getByTestId('joint-nose');
    expect(joint.getAttribute('cx')).toBe('25');
    expect(joint.getAttribute('cy')).toBe('75');
  });

  it('keeps two people apart', () => {
    render(
      <PoseOverlay
        skeletons={[
          { id: 'trk_left', keypoints: [{ name: 'nose', x: 0.1, y: 0.5, confidence: 0.9, visible: true }] },
          { id: 'trk_right', keypoints: [{ name: 'nose', x: 0.9, y: 0.5, confidence: 0.9, visible: true }] },
        ]}
      />,
    );
    expect(screen.getByTestId('pose-trk_left').querySelector('circle')?.getAttribute('cx')).toBe('10');
    expect(screen.getByTestId('pose-trk_right').querySelector('circle')?.getAttribute('cx')).toBe('90');
  });

  it('connects limbs by joint NAME, so an unknown skeleton order draws nothing rather than the wrong limb', () => {
    const kp: PoseKeypoint[] = [
      { name: 'joint_0', x: 0.1, y: 0.1, confidence: 0.9, visible: true },
      { name: 'joint_1', x: 0.9, y: 0.9, confidence: 0.9, visible: true },
    ];
    const { container } = render(<PoseOverlay skeletons={[{ id: 'trk_1', keypoints: kp }]} />);
    expect(container.querySelectorAll('line')).toHaveLength(0);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('declares 19 COCO-17 limbs, each between two of the 17 named joints', () => {
    expect(POSE_EDGES).toHaveLength(19);
    for (const [a, b] of POSE_EDGES) {
      expect(JOINTS).toContain(a);
      expect(JOINTS).toContain(b);
    }
  });
});

describe('parsePose', () => {
  const payload = {
    skeleton: 'coco-17',
    model: 'rtmpose-tiny',
    artifactSha256: '38b1d472',
    threshold: 0.3,
    visibleMeaning: 'model-localized above threshold; NOT a claim about physical occlusion',
    keypoints: [{ name: 'nose', x: 0.5, y: 0.4, confidence: 0.9, visible: true }],
  };

  it('reads the runtime payload', () => {
    const pose = parsePose({ pose: payload });
    expect(pose?.model).toBe('rtmpose-tiny');
    expect(pose?.threshold).toBe(0.3);
    expect(pose?.keypoints).toHaveLength(1);
  });

  it('returns null when the track carries no pose', () => {
    expect(parsePose({})).toBeNull();
    expect(parsePose(undefined)).toBeNull();
    expect(parsePose({ pose: null })).toBeNull();
  });

  it('drops a keypoint with a non-finite coordinate rather than drawing it at the origin', () => {
    const pose = parsePose({
      pose: { ...payload, keypoints: [...payload.keypoints, { name: 'left_eye', x: Number.NaN, y: 0.4, confidence: 0.9, visible: true }] },
    });
    expect(pose?.keypoints.map((k) => k.name)).toEqual(['nose']);
  });

  it('refuses a keypoint whose visibility the runtime did not state', () => {
    const pose = parsePose({ pose: { ...payload, keypoints: [{ name: 'nose', x: 0.5, y: 0.4, confidence: 0.9 }] } });
    expect(pose).toBeNull();
  });

  it('never derives visibility from confidence', () => {
    const pose = parsePose({
      pose: { ...payload, keypoints: [{ name: 'nose', x: 0.5, y: 0.4, confidence: 0.99, visible: false }] },
    });
    expect(pose?.keypoints[0]?.visible).toBe(false);
  });
});
