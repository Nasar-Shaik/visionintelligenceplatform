import { useMemo, useState } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import {
  rectanglePoints,
  validateZoneGeometry,
  type CreateDetectionZoneInput,
  type Point2D,
} from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  QueryBoundary,
} from '@/ui';
import { useCameras } from '@/features/cameras/useCameras';
import { useLiveTracks } from '@/features/tracking/useTracking';
import { ZoneCanvas } from './ZoneCanvas';
import { useZoneMutations, useZones } from './useLoitering';

/**
 * **Zone Editor** (P-8 Phase 7 §Operator UI).
 *
 * Draw, name, enable and delete the polygons a loitering rule points at. Everything on this page is
 * deployment truth: the zones listed are the zones stored, and the subjects drawn are the subjects
 * the tracker currently reports.
 *
 * ### ⚠️ Why a zone cannot be saved until the geometry validates
 *
 * The same `validateZoneGeometry` the camera service runs is called here, on every click. A bow-tie
 * polygon has no unambiguous inside — the browser would shade it one way and the server would
 * evaluate it another — so the operator is told while they are still drawing rather than by a 400
 * afterwards. ⚠️ The server remains the authority; this is the same check, imported, not a second
 * implementation of it.
 */
export function ZoneEditorPage() {
  const canRead = usePermission('camera:read');
  const canWrite = usePermission('camera:write');
  const cameras = useCameras();
  const [cameraId, setCameraId] = useState<string>('');
  const zones = useZones(cameraId === '' ? undefined : cameraId);
  /* ⚠️ Only the cameras this operator chose — a tenant-wide track feed on an editor page would poll
   * every camera in the estate at two-second intervals to draw one. */
  const tracks = useLiveTracks(cameraId === '' ? {} : { cameraId });
  const { create, update, remove } = useZoneMutations(cameraId === '' ? undefined : cameraId);

  const [draft, setDraft] = useState<Point2D[]>([]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  /**
   * ⭐ **Which kind of thing is being drawn** (slice 2.9). An `area` answers *were they inside it*;
   * a `line` answers *did they pass through it*. They are different questions with different
   * evaluators, and the operator has to choose before the first click — a shape reinterpreted after
   * the fact is a zone that evaluates something nobody drew.
   */
  const [kind, setKind] = useState<'area' | 'line'>('area');
  const minPoints = kind === 'line' ? 2 : 3;

  /** Live geometry verdict, recomputed on every click. */
  const problems = useMemo(
    () => (draft.length >= minPoints ? validateZoneGeometry({ points: draft }, kind) : []),
    [draft, kind, minPoints],
  );
  const canSave =
    canWrite &&
    cameraId !== '' &&
    name.trim() !== '' &&
    draft.length >= minPoints &&
    problems.length === 0;

  const cameraOptions = cameras.data?.cameras ?? [];
  const zoneList = zones.data ?? [];

  const save = (): void => {
    const input: CreateDetectionZoneInput = {
      cameraId,
      name: name.trim(),
      kind,
      /*
       * ⚠️ `polygon` even for a four-point shape drawn as a rectangle. `shape` records the drawing
       * tool so the editor can re-open it with corner handles; it never changes evaluation, and
       * claiming `rectangle` for a hand-drawn quadrilateral would make a later edit refuse to save
       * (a rectangle must be exactly four points).
       *
       * ⚠️ `line` is the exception: there the shape and the kind must agree, because the camera
       * service checks `ZONE_EVALUATION[shape].kind` and a `line` declared as an area would be fed
       * to a point-in-polygon test — a zone the operator drew, saw, and that evaluates nothing.
       */
      shape: kind === 'line' ? 'line' : 'polygon',
      geometry: { points: draft },
      enabled: true,
      attributes: {},
      ...(purpose.trim() === '' ? {} : { purpose: purpose.trim() }),
    };
    create.mutate(input, {
      onSuccess: () => {
        setDraft([]);
        setName('');
        setPurpose('');
      },
    });
  };

  if (!canRead) {
    return (
      <Alert variant="warning" title="Not permitted">
        You do not have permission to view detection zones.
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zone Editor"
        description="Named areas on a camera's picture. A loitering rule watches zones; an incident names the zone and the version of it that was in force."
      />

      <Card>
        <CardHeader>
          <CardTitle>Camera</CardTitle>
          <CardDescription>
            Zones belong to one camera. Choose one to see and draw its zones.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
           * ⚠️ A native `<select>`, not the Radix `Select` in the kit. The kit's is a listbox built
           * from divs; this page is exercised by browser verification that picks a camera by label,
           * and a native control is the one every assistive technology and every driver already
           * knows how to operate.
           */}
          <select
            aria-label="Camera"
            className="focus-ring h-9 w-full rounded-md border border-input bg-surface-1 px-3 text-sm"
            value={cameraId}
            onChange={(event) => {
              setCameraId(event.target.value);
              setDraft([]);
            }}
          >
            <option value="">Select a camera…</option>
            {cameraOptions.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {cameraId === '' ? (
        <EmptyState
          title="No camera selected"
          description="A zone is an area or a line on one camera's image plane, so there is nothing to draw until you pick one."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Zones on this camera</CardTitle>
              <CardDescription>
                {canWrite
                  ? kind === 'line'
                    ? 'Click to place points. Two or more make a line; a crossing is reported when a subject passes through it.'
                    : 'Click to place points. Three or more make an area.'
                  : 'Read-only — drawing needs camera:write.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {canWrite ? (
                <fieldset className="flex flex-wrap items-center gap-3">
                  <legend className="sr-only">What to draw</legend>
                  {/*
                    ⭐ Chosen before the first click, because an area and a line are different
                    questions with different evaluators — see the `kind` state.
                  */}
                  {(['area', 'line'] as const).map((option) => (
                    <label key={option} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="radio"
                        name="zone-kind"
                        value={option}
                        checked={kind === option}
                        data-testid={`zone-kind-${option}`}
                        onChange={() => {
                          setKind(option);
                          /* ⚠️ The draft is cleared: three points meant as a polygon are a bent
                             tripwire, and reusing them would save geometry nobody drew. */
                          setDraft([]);
                        }}
                      />
                      {option === 'area' ? 'Area — were they inside it' : 'Line — did they cross it'}
                    </label>
                  ))}
                  <span className="text-xs text-fg-muted">
                    {kind === 'line'
                      ? 'Two or more points. ⛔ Reach the frame edges — a crossing is anchored at the subject’s feet, which sit near the bottom of the picture, so a line that stops short is walked around rather than through. The first point is marked: it sets which side the platform calls left.'
                      : 'Three or more points enclose an area.'}
                  </span>
                </fieldset>
              ) : null}

              <ZoneCanvas
                zones={zoneList}
                draft={draft}
                draftKind={kind}
                tracks={tracks.data?.tracks ?? []}
                label={`Detection zones on ${cameraId}`}
                {...(canWrite
                  ? { onAddPoint: (point: Point2D) => setDraft((d) => [...d, point]) }
                  : {})}
              />

              {problems.length > 0 ? (
                <Alert variant="warning">{problems.map((p) => p.message).join('; ')}</Alert>
              ) : null}

              {canWrite ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-40 flex-1">
                    <Label htmlFor="zone-name">Zone name</Label>
                    <Input
                      id="zone-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Checkout Queue"
                    />
                  </div>
                  <div className="min-w-32 flex-1">
                    <Label htmlFor="zone-purpose">Purpose (optional)</Label>
                    <Input
                      id="zone-purpose"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder="checkout"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => setDraft((d) => d.slice(0, -1))}
                    disabled={draft.length === 0}
                  >
                    <Undo2 className="size-4" /> Undo point
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={kind === 'line'}
                    onClick={() => setDraft(rectanglePoints(0.25, 0.35, 0.5, 0.5))}
                  >
                    Rectangle
                  </Button>
                  {/*
                    ⭐ A vertical tripwire down the middle — the shape a doorway or an aisle mouth
                    actually has.

                    ⛔ **Edge to edge, 0 → 1, and the margin is not cosmetic.** The first version of
                    this preset used 0.05 → 0.95 because it looked tidier, and on real footage it
                    caught a person walking straight across it **zero** times. A crossing is anchored
                    at the FOOT point and a standing person's feet sit at y ≈ 0.95, so the walk passed
                    around the bottom end of the line — correctly refused by the geometry, and
                    completely invisible. Measured, not reasoned about; `lineDiagnostics` now names
                    the same situation when an operator draws one by hand.
                  */}
                  <Button
                    variant="secondary"
                    disabled={kind !== 'line'}
                    data-testid="zone-preset-tripwire"
                    onClick={() =>
                      setDraft([
                        [0.5, 0],
                        [0.5, 1],
                      ])
                    }
                  >
                    Tripwire
                  </Button>
                  <Button onClick={save} disabled={!canSave || create.isPending}>
                    <Plus className="size-4" /> Save zone
                  </Button>
                </div>
              ) : null}

              {create.isError ? (
                <Alert variant="critical">{(create.error as Error).message}</Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Stored zones</CardTitle>
              <CardDescription>
                A disabled zone is not evaluated and is not deleted — every incident that names it
                still resolves.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <QueryBoundary
                isLoading={zones.isLoading}
                isError={zones.isError}
                error={zones.error}
                skeleton={<div className="h-24 animate-pulse rounded bg-surface-3" />}
              >
                {zoneList.length === 0 ? (
                  <EmptyState
                    title="No zones yet"
                    description="Draw one on the canvas. Until a zone exists, every event from this camera carries no zone and a zone-scoped rule matches nothing."
                  />
                ) : (
                  <ul className="space-y-3">
                    {zoneList.map((zone) => (
                      <li
                        key={zone.id}
                        className="flex items-start justify-between gap-3 rounded border border-border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{zone.name}</p>
                          <p className="text-xs text-fg-muted">
                            {/* ⭐ The kind, named. An area and a line answer different questions,
                                and a list that showed only a point count hid which one this is. */}
                            {zone.kind === 'line' ? 'line' : 'area'} · {zone.geometry.points.length}{' '}
                            points · v{zone.version}
                            {zone.purpose ? ` · ${zone.purpose}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={zone.enabled ? 'success' : 'neutral'}>
                            {zone.enabled ? 'Evaluated' : 'Off'}
                          </Badge>
                          {canWrite ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`${zone.enabled ? 'Disable' : 'Enable'} ${zone.name}`}
                                onClick={() =>
                                  update.mutate({
                                    zoneId: zone.id,
                                    patch: { enabled: !zone.enabled },
                                  })
                                }
                              >
                                {zone.enabled ? 'Disable' : 'Enable'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Delete ${zone.name}`}
                                onClick={() => remove.mutate(zone.id)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </QueryBoundary>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
