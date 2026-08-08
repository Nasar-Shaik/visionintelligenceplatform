/**
 * **Live Capture** — this laptop's webcam, ingested by the production perception pipeline (P-9).
 *
 * ### ⭐ What this page is, and what it deliberately is not
 *
 * It is a **frame producer**. It grabs pixels, encodes them, and posts them to
 * `POST /media/live/:cameraId/frame`, which hands them to `FrameSink.push()` — the same door the
 * RTSP decoder pushes through, one line apart in the same file. Everything after that door
 * (assignment gate, runtime, tracker, zone capture, event publisher, rule engine, incidents,
 * evidence) is untouched by this milestone and unaware that a browser exists.
 *
 * It is **not** a live AI pipeline, a second tracker, or a "webcam mode". If any behaviour on this
 * page could not be reproduced by pointing an RTSP camera at the same deployment, something has gone
 * wrong with the architecture and not with the page.
 *
 * ### ⚠️ The preview is not mirrored, and that is not an oversight
 *
 * Every consumer webcam app mirrors the preview, because a mirrored image is what people expect of
 * their own face. The detector sees the **un-mirrored** frame, so its boxes are in un-mirrored
 * coordinates — drawing them over a mirrored preview puts every box on the wrong side of the
 * picture, and does so *plausibly*, which is worse. A person standing at the left edge would be
 * boxed at the right edge, and nobody watching a validation demo would call it a bug.
 *
 * ### ⚠️ The boxes are late, and the page says by how much
 *
 * Tracks are polled; a poll is at best one interval behind, and the track it returns describes the
 * last frame the runtime finished. So the overlay lags the preview by a measurable amount, and the
 * page prints that number rather than presenting the composite as a live view. An overlay that
 * *looks* real-time but is 1.8 s behind is a demonstration that quietly misrepresents the product.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetectionOverlay,
  PageHeader,
  type DetectionBox,
} from '@/ui';
import { useCameras } from '@/features/cameras/useCameras';
import { useLiveTracks } from '@/features/tracking/useTracking';
import {
  LiveCaptureLoop,
  bytesToBase64,
  describeCameraError,
  estimateClockOffset,
  fitCapture,
  type CapturedFrame,
  type FrameAttempt,
  type StageStats,
} from './capture';
import {
  closeLiveSession,
  openLiveSession,
  postLiveFrame,
  useCameraProcessing,
  useLiveSessions,
  type LiveSession,
} from './useLivecam';

type Phase = 'idle' | 'starting' | 'live' | 'stopping' | 'error';

/** The rates the FPS benchmark exercises. Offered as buttons so a run is reproducible by clicking. */
const FPS_CHOICES = [1, 2, 4, 8, 15] as const;
/** Longest edge of the encoded frame. 640 matches the detector's input; larger only costs bandwidth. */
const EDGE_CHOICES = [320, 480, 640, 960, 1280] as const;

export function LiveCamPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<LiveCaptureLoop | null>(null);
  /** ⚠️ Held in a ref as well as state: the unmount cleanup must close the session it actually opened. */
  const activeCameraRef = useRef<string>('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ code: string; message: string; retry: boolean } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [cameraId, setCameraId] = useState<string>('');
  const [fps, setFps] = useState<number>(4);
  const [maxEdge, setMaxEdge] = useState<number>(640);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [clock, setClock] = useState<{
    offsetMs: number;
    uncertaintyMs: number;
    roundTripMs: number;
  } | null>(null);
  const [lastAttempt, setLastAttempt] = useState<FrameAttempt | null>(null);
  const [geometry, setGeometry] = useState<{ w: number; h: number; source: string } | null>(null);
  /** Bumped on a timer so the statistics panel re-renders without the loop touching React. */
  const [, setPulse] = useState(0);

  const live = phase === 'live';
  const cameras = useCameras({ limit: 100 });
  const tracks = useLiveTracks(live && cameraId !== '' ? { cameraId } : {});
  const processing = useCameraProcessing(live);
  const sessions = useLiveSessions(true);

  /* ── device enumeration ────────────────────────────────────────────────────────────────────── */

  /**
   * ⚠️ **Labels are blank until a permission has been granted, by design in every browser.** So the
   * first enumeration usually yields "Camera 1 / Camera 2" with no names; after `getUserMedia`
   * succeeds once, the same call returns real labels. Enumerating again after start is what makes
   * the picker useful, and skipping it is why device pickers so often show nothing recognisable.
   */
  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.enumerateDevices === undefined) {
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput'));
    } catch {
      /* An enumeration failure is not worth an error banner — the default device still works. */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (md?.addEventListener === undefined) return;
    const onChange = () => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  /* ── capture ───────────────────────────────────────────────────────────────────────────────── */

  const grabFrame = useCallback(async (): Promise<CapturedFrame | null> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video === null || canvas === null) return null;
    /*
     * ⚠️ `videoWidth` is 0 until the first frame has decoded. Encoding then produces a 0×0 canvas,
     * which `toBlob` happily turns into a tiny valid JPEG of nothing — accepted by the platform,
     * analysed, and detected as an empty scene. A null here is the difference between "the camera
     * has not started yet" and "the camera is pointed at an empty room".
     */
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;

    const fit = fitCapture(video.videoWidth, video.videoHeight, maxEdge);
    if (canvas.width !== fit.width || canvas.height !== fit.height) {
      canvas.width = fit.width;
      canvas.height = fit.height;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;

    const capturedAtMs = Date.now();
    const t0 = performance.now();
    ctx.drawImage(video, 0, 0, fit.width, fit.height);
    const t1 = performance.now();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    });
    const t2 = performance.now();
    if (blob === null) return null;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      image: bytesToBase64(bytes),
      bytes: bytes.byteLength,
      captureMs: t1 - t0,
      encodeMs: t2 - t1,
      capturedAtMs,
    };
  }, [maxEdge]);

  const stop = useCallback(async () => {
    setPhase('stopping');
    loopRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
    const camera = activeCameraRef.current;
    activeCameraRef.current = '';
    if (camera !== '') {
      /*
       * ⚠️ A failed close is not an error worth showing. The session's own idle reaper takes it
       * within 60 s, so the worst case is a camera that reads as claimed for a minute — and telling
       * an operator that stopping failed, when stopping did in fact stop the camera, is worse.
       */
      await closeLiveSession(camera).catch(() => undefined);
    }
    setPhase('idle');
  }, []);

  const start = useCallback(async () => {
    if (cameraId === '') {
      setError({ code: 'no-camera', message: 'Choose the camera this capture feeds.', retry: false });
      setPhase('error');
      return;
    }
    setError(null);
    setPhase('starting');
    try {
      /*
       * ⚠️ `deviceId` is `ideal`, not `exact`. `exact` on a device that has been unplugged fails
       * with OverconstrainedError and leaves the operator with no camera at all; `ideal` falls back
       * to whatever is present, which is the behaviour a recovery path needs after a device change.
       * Audio is never requested — the deployment's Permissions-Policy denies the microphone, so
       * asking would fail the whole call rather than degrade.
       */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId === '' ? {} : { deviceId: { ideal: deviceId } }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      void refreshDevices();

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      setGeometry({
        w: settings.width ?? 0,
        h: settings.height ?? 0,
        source: track?.label ?? 'camera',
      });
      /*
       * ⛔ **Unplugging the webcam fires `ended` on the track and nothing else.** The stream object
       * stays, `getUserMedia` never rejects again, and the video element simply freezes on its last
       * frame — so without this the page would keep posting the *same* frozen frame for ever, the
       * platform would keep detecting the person in it, and the incident timeline would show
       * somebody standing perfectly still until the tab was closed. That is a fabricated
       * observation, which is the one class of defect an evidence platform cannot ship.
       */
      track?.addEventListener('ended', () => {
        setError({
          code: 'device-lost',
          message:
            'The camera stopped producing video — it was unplugged, disabled, or taken by another application. Capture stopped so no repeated frame is ingested.',
          retry: true,
        });
        void stop();
        setPhase('error');
      });

      const t0 = Date.now();
      const opened = await openLiveSession(cameraId, {
        frameRate: fps,
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        agent: 'browser-webcam',
      });
      const t1 = Date.now();
      setSession(opened);
      setClock(estimateClockOffset(t0, t1, Date.parse(opened.startedAt)));
      activeCameraRef.current = cameraId;

      const loop = new LiveCaptureLoop({
        fps,
        capture: grabFrame,
        upload: async (frame) => {
          try {
            const accepted = await postLiveFrame(cameraId, {
              image: frame.image,
              capturedAtMs: frame.capturedAtMs,
            });
            return { ok: true, seq: accepted.seq, arrivalLagMs: accepted.arrivalLagMs };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
        onAttempt: setLastAttempt,
      });
      loopRef.current = loop;
      setPhase('live');
      void loop.run();
    } catch (err) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError(describeCameraError(err));
      setPhase('error');
    }
  }, [cameraId, deviceId, fps, grabFrame, refreshDevices, stop]);

  /* ── statistics pulse ──────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!live) return;
    const handle = window.setInterval(() => setPulse((p) => p + 1), 500);
    return () => window.clearInterval(handle);
  }, [live]);

  /**
   * ⛔ **Stop the camera when the page goes away, always.** A React unmount, a route change or a
   * closed tab all end this component; none of them releases a `MediaStream` on their own. The
   * indicator light stays on, the device stays claimed against every other application, and the
   * ingest session lives until the reaper notices. The light is the part an operator will remember.
   */
  useEffect(
    () => () => {
      loopRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const camera = activeCameraRef.current;
      if (camera !== '') void closeLiveSession(camera).catch(() => undefined);
    },
    [],
  );

  /* ── derived view ──────────────────────────────────────────────────────────────────────────── */

  const boxes: DetectionBox[] = useMemo(() => {
    const rows = tracks.data?.tracks ?? [];
    return rows
      .filter((t) => t.cameraId === cameraId && (t.state === 'confirmed' || t.state === 'tentative'))
      .map((t) => ({
        id: t.trackId,
        label: `${t.label} · ${t.trackId.slice(-6)}`,
        confidence: t.confidence,
        x: t.bbox[0],
        y: t.bbox[1],
        width: t.bbox[2],
        height: t.bbox[3],
      }));
  }, [tracks.data, cameraId]);

  /**
   * How stale the boxes are, in seconds — the newest `lastSeen` among the drawn tracks against now.
   *
   * ⚠️ `null` when nothing is drawn, and the panel says "no tracks" rather than "0.0 s". An age of
   * zero would be the one number this cannot honestly produce.
   */
  const boxAgeSeconds = useMemo(() => {
    const rows = (tracks.data?.tracks ?? []).filter((t) => t.cameraId === cameraId);
    if (rows.length === 0) return null;
    const newest = Math.max(...rows.map((t) => Date.parse(t.lastSeen.at)));
    return Number.isFinite(newest) ? (Date.now() - newest) / 1000 : null;
  }, [tracks.data, cameraId]);

  const mine = processing.data?.find((c) => c.cameraId === cameraId);
  const loop = loopRef.current;
  const cameraOptions = cameras.data?.cameras ?? [];
  const otherSessions = (sessions.data ?? []).filter((s) => s.cameraId !== activeCameraRef.current);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live Capture"
        description="This device's camera, ingested by the production perception pipeline — the same runtime, tracker, rules and incident path that analyses stored video."
      />

      {error !== null && (
        <Alert variant="critical" data-testid="livecam-error">
          <strong className="font-medium">{error.code}</strong> — {error.message}
          {/*
           * ⚠️ `retry` is rendered rather than merely recorded, and the negative case is the one
           * that matters. Leaving Start looking equally useful after an insecure-context or
           * missing-backend failure invites an operator to press it repeatedly against something
           * that cannot succeed — and to conclude the platform is broken rather than the browser.
           */}
          <span className="ml-1 text-muted-foreground">
            {error.retry
              ? 'Press Start capture to try again.'
              : 'Starting again will not help until the cause above is fixed.'}
          </span>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Ingest into camera</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5"
                value={cameraId}
                disabled={live}
                onChange={(e) => setCameraId(e.target.value)}
                data-testid="livecam-camera"
              >
                <option value="">Choose a camera…</option>
                {cameraOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Capture device</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5"
                value={deviceId}
                disabled={live}
                onChange={(e) => setDeviceId(e.target.value)}
                data-testid="livecam-device"
              >
                <option value="">System default</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label === '' ? `Camera ${String(i + 1)}` : d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-6">
            <div className="space-y-1 text-sm">
              <span className="text-muted-foreground">Frame rate</span>
              <div className="flex gap-1">
                {FPS_CHOICES.map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={f === fps ? 'primary' : 'outline'}
                    disabled={live}
                    onClick={() => setFps(f)}
                  >
                    {f} fps
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1 text-sm">
              <span className="text-muted-foreground">Longest edge</span>
              <div className="flex gap-1">
                {EDGE_CHOICES.map((e) => (
                  <Button
                    key={e}
                    size="sm"
                    variant={e === maxEdge ? 'primary' : 'outline'}
                    disabled={live}
                    onClick={() => setMaxEdge(e)}
                  >
                    {e}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              {live ? (
                <Button variant="destructive" onClick={() => void stop()} data-testid="livecam-stop">
                  Stop capture
                </Button>
              ) : (
                <Button
                  onClick={() => void start()}
                  disabled={phase === 'starting'}
                  data-testid="livecam-start"
                >
                  {phase === 'starting' ? 'Starting…' : 'Start capture'}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Preview
              <Badge variant={live ? 'brand' : 'outline'}>{phase}</Badge>
              {geometry !== null && (
                <span className="text-2xs font-normal text-muted-foreground tabular">
                  {geometry.source} · {geometry.w}×{geometry.h} → {maxEdge}px edge
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="relative overflow-hidden rounded-md bg-black">
              {/* A live camera feed has no caption track and no audio; it is decorative to a screen
                  reader, and the counts and stage tables below carry the information. */}
              <video
                ref={videoRef}
                className="block w-full"
                playsInline
                muted
                autoPlay
                data-testid="livecam-video"
              />
              <DetectionOverlay detections={boxes} />
            </div>
            <canvas ref={canvasRef} className="hidden" data-testid="livecam-canvas" />
            <p className="text-2xs text-muted-foreground tabular" data-testid="livecam-overlay-age">
              {boxes.length === 0
                ? 'No tracks on this camera right now.'
                : `${String(boxes.length)} tracked ${boxes.length === 1 ? 'subject' : 'subjects'} · boxes are ${
                    boxAgeSeconds === null ? 'of unknown age' : `${boxAgeSeconds.toFixed(1)} s behind the preview`
                  }`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Browser stages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <StageTable
              rows={[
                ['Capture (video → canvas)', loop?.stages.capture.stats() ?? null],
                ['Encode (canvas → JPEG)', loop?.stages.encode.stats() ?? null],
                ['Upload (round trip)', loop?.stages.upload.stats() ?? null],
                ['Transport (service-measured)', loop?.stages.transport.stats() ?? null],
              ]}
            />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs tabular">
              <Stat label="Ticks" value={loop?.counters.ticks ?? null} />
              <Stat label="Accepted" value={loop?.counters.accepted ?? null} />
              <Stat label="Skipped (busy)" value={loop?.counters.skippedBusy ?? null} />
              <Stat label="Rejected" value={loop?.counters.rejected ?? null} />
              <Stat label="Failed" value={loop?.counters.failed ?? null} />
              <Stat
                label="Achieved fps"
                value={loop?.achievedFps()?.toFixed(2) ?? null}
              />
              <Stat
                label="Sent"
                value={
                  loop === null || loop.counters.bytesSent === 0
                    ? null
                    : `${(loop.counters.bytesSent / 1_048_576).toFixed(1)} MB`
                }
              />
              <Stat label="Last seq" value={lastAttempt?.seq ?? null} />
            </dl>
            {clock !== null && (
              /*
               * ⚠️ Printed with its uncertainty, always. `arrivalLagMs` is transport time PLUS clock
               * skew and the two are not separable from one sample; an offset quoted without the
               * round trip it was estimated over is a false precision.
               */
              <p className="text-2xs text-muted-foreground tabular" data-testid="livecam-clock">
                Browser clock vs platform clock: {clock.offsetMs >= 0 ? '+' : ''}
                {clock.offsetMs.toFixed(0)} ms ± {clock.uncertaintyMs.toFixed(0)} ms (estimated over
                a {clock.roundTripMs.toFixed(0)} ms round trip)
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Platform stages — measured by the pipeline, not by this page</CardTitle>
        </CardHeader>
        <CardContent>
          {mine === undefined ? (
            <p className="text-sm text-muted-foreground">
              {live
                ? 'No processing metrics for this camera yet. If this persists, the camera has no AI processing assignment — frames are accepted and then skipped at the gate.'
                : 'Start a capture to see the pipeline’s own measurements.'}
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm tabular md:grid-cols-4">
              <Stat label="State" value={mine.state} />
              <Stat label="Processing fps" value={mine.processingFps?.toFixed(2) ?? null} />
              <Stat label="Queue depth" value={mine.queueDepth} />
              <Stat label="Dropped (queue full)" value={mine.framesDroppedQueueFull} />
              <Stat label="Offered" value={mine.framesOffered} />
              <Stat label="Delivered" value={mine.framesDelivered} />
              <Stat label="Skipped (unassigned)" value={mine.framesSkippedUnassigned} />
              <Stat
                label="Media → runtime"
                value={mine.processingLatencyMs === null ? null : `${mine.processingLatencyMs.toFixed(0)} ms`}
              />
              <Stat label="Events published" value={mine.eventsPublished} />
              <Stat label="Active tracks" value={mine.activeTracks} />
              <Stat label="Profile" value={mine.profileId} />
              <Stat label="Runtime" value={mine.runtimeId} />
            </dl>
          )}
          {mine?.lastError !== undefined && (
            <p className="mt-2 text-2xs text-destructive">
              Last pipeline error {mine.lastErrorAt ?? ''}: {mine.lastError}
            </p>
          )}
        </CardContent>
      </Card>

      {otherSessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Other live ingest sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm tabular">
              {otherSessions.map((s) => (
                <li key={s.sessionId}>
                  <span className="text-muted-foreground">{s.cameraId}</span> · {s.agent} ·{' '}
                  {s.framesAccepted} frames · opened {new Date(s.startedAt).toLocaleTimeString()}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {session !== null && (
        <p className="text-2xs text-muted-foreground tabular">
          Session {session.sessionId} · opened {session.startedAt} · frames are stamped with the
          platform’s clock, never the browser’s.
        </p>
      )}
    </div>
  );
}

function StageTable({ rows }: { rows: [string, StageStats | null][] }) {
  return (
    <table className="w-full text-2xs tabular">
      <thead className="text-muted-foreground">
        <tr>
          <th className="text-left font-medium">Stage</th>
          <th className="text-right font-medium">n</th>
          <th className="text-right font-medium">min</th>
          <th className="text-right font-medium">avg</th>
          <th className="text-right font-medium">p95</th>
          <th className="text-right font-medium">max</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, s]) => (
          <tr key={name}>
            <td className="py-0.5">{name}</td>
            {/*
             * ⚠️ An unmeasured stage prints an em dash across every column, never zeros. "0.0 ms"
             * and "nothing has been measured" look alike and mean opposite things — and on a page
             * whose entire output is latency numbers, that confusion is the failure mode.
             */}
            {s === null ? (
              <td className="py-0.5 text-right text-muted-foreground" colSpan={5}>
                — not measured yet
              </td>
            ) : (
              <>
                <td className="py-0.5 text-right">{s.count}</td>
                <td className="py-0.5 text-right">{s.min.toFixed(1)}</td>
                <td className="py-0.5 text-right">{s.avg.toFixed(1)}</td>
                <td className="py-0.5 text-right">{s.p95.toFixed(1)}</td>
                <td className="py-0.5 text-right">{s.max.toFixed(1)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </div>
  );
}
