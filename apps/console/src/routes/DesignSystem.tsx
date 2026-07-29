import type { ReactNode } from 'react';
import { Bell, Camera, Plus, Settings, ShieldAlert } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CameraTile,
  DetectionOverlay,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FilterBar,
  IncidentCard,
  Input,
  Label,
  MetricCard,
  NotificationCard,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SeverityBadge,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusIndicator,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TableSkeleton,
  Textarea,
  Timeline,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  VideoPlayerContainer,
} from '@/ui';
import { SEVERITY_ORDER } from '@/lib/severity';
import type { StatusKind } from '@/lib/status';

const STATUS_KINDS: StatusKind[] = ['ok', 'warn', 'error', 'idle'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="rounded-lg border border-border bg-surface-1/50 p-5">{children}</div>
    </section>
  );
}

// Full static class names (Tailwind can't see `bg-${token}`).
const COLOR_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['bg-bg', 'canvas'],
  ['bg-surface-1', 'surface-1'],
  ['bg-surface-2', 'surface-2'],
  ['bg-surface-3', 'surface-3'],
  ['bg-border-strong', 'border'],
  ['bg-brand', 'brand'],
  ['bg-success', 'success'],
  ['bg-warning', 'warning'],
  ['bg-critical', 'critical'],
];

/** Design System gallery (dev route `/design`) — every primitive + variant + state. */
export function DesignSystem() {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto max-w-5xl space-y-10 px-6 py-10">
        <PageHeader
          title="Design System"
          description="Operations Console — dark SOC tokens, primitives, and composites. Every page composes these."
          breadcrumbs={[{ label: 'Console' }, { label: 'Design System' }]}
          actions={<Badge variant="brand">P2-1.1</Badge>}
        />

        <Section title="Color tokens">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {COLOR_TOKENS.map(([cls, label]) => (
              <div key={label} className="space-y-1.5">
                <div className={`h-12 rounded-md border border-border ${cls}`} />
                <p className="text-2xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Typography">
          <div className="space-y-2">
            <p className="text-3xl font-semibold">Big metric numerals — 30px</p>
            <p className="text-2xl font-semibold">Page title — 24px</p>
            <p className="text-xl font-semibold">Section header — 20px</p>
            <p className="text-lg font-semibold">Card title — 16px</p>
            <p className="text-base">Primary body — 14px</p>
            <p className="text-sm text-muted-foreground">Operator body — 13px muted</p>
            <p className="tabular text-xs text-text-subtle">
              MONO / IDs 12px · corr_9f2c…a1 · 24 fps · 18 ms
            </p>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
            <Button loading>Loading</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Add">
              <Plus />
            </Button>
          </div>
        </Section>

        <Section title="Severity (EventPriority)">
          <div className="flex flex-wrap items-center gap-3">
            {SEVERITY_ORDER.map((s) => (
              <SeverityBadge key={s} severity={s} />
            ))}
            <Separator orientation="vertical" className="h-6" />
            {SEVERITY_ORDER.map((s) => (
              <SeverityBadge key={`dot-${s}`} severity={s} dot />
            ))}
          </div>
        </Section>

        <Section title="Status">
          <div className="flex flex-wrap items-center gap-5">
            {STATUS_KINDS.map((s) => (
              <StatusIndicator key={s} status={s} emphasis />
            ))}
            <StatusIndicator status="ok" label="Live" pulse emphasis />
          </div>
        </Section>

        <Section title="Badges & Alerts">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge>neutral</Badge>
              <Badge variant="outline">outline</Badge>
              <Badge variant="brand">brand</Badge>
              <Badge variant="success">success</Badge>
              <Badge variant="warning">warning</Badge>
              <Badge variant="critical">critical</Badge>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <Alert variant="info" title="Info">
                A new capability is available for this tenant.
              </Alert>
              <Alert variant="success" title="Resolved">
                Incident #4821 was resolved.
              </Alert>
              <Alert variant="warning" title="Degraded">
                Camera stream reconnecting.
              </Alert>
              <Alert variant="critical" title="Critical">
                Intrusion detected — zone A.
              </Alert>
            </div>
          </div>
        </Section>

        <Section title="Forms">
          <div className="grid max-w-md gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ds-name">Camera name</Label>
              <Input id="ds-name" placeholder="Lobby — East" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-profile">Analysis profile</Label>
              <Select>
                <SelectTrigger id="ds-profile">
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General Surveillance</SelectItem>
                  <SelectItem value="retail">Retail Security</SelectItem>
                  <SelectItem value="warehouse">Warehouse Safety</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-note">Note</Label>
              <Textarea id="ds-note" placeholder="Add context…" />
            </div>
            <div className="flex items-center gap-3">
              <Switch id="ds-live" defaultChecked />
              <Label htmlFor="ds-live">Enable live analysis</Label>
            </div>
          </div>
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Resolve incident</DialogTitle>
                  <DialogDescription>Confirm resolution of incident #4821.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost">Cancel</Button>
                  <Button>Resolve</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open drawer</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Incident detail</SheetTitle>
                </SheetHeader>
                <SheetBody>
                  <p className="text-sm text-muted-foreground">
                    Right-side detail drawer keeps page context.
                  </p>
                </SheetBody>
              </SheetContent>
            </Sheet>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Settings /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Bell /> Mute
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Info">
                  <ShieldAlert />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Correlation id threaded end-to-end</TooltipContent>
            </Tooltip>

            <Button
              variant="secondary"
              onClick={() => toast('Critical incident', { description: 'Zone A intrusion' })}
            >
              Fire toast
            </Button>
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="events">
            <TabsList>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="incidents">Incidents</TabsTrigger>
              <TabsTrigger value="alerts">Alerts</TabsTrigger>
            </TabsList>
            <TabsContent value="events">
              <p className="text-sm text-muted-foreground">Event timeline content.</p>
            </TabsContent>
            <TabsContent value="incidents">
              <p className="text-sm text-muted-foreground">Incident list content.</p>
            </TabsContent>
            <TabsContent value="alerts">
              <p className="text-sm text-muted-foreground">Alert delivery content.</p>
            </TabsContent>
          </Tabs>
        </Section>

        <Section title="Metric cards">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Active incidents"
              value={7}
              delta={12}
              tone="critical"
              icon={<ShieldAlert className="size-4" />}
              data={[3, 5, 4, 6, 5, 7]}
            />
            <MetricCard
              label="Cameras online"
              value="24/26"
              delta={-2}
              deltaSuffix=""
              tone="warning"
              icon={<Camera className="size-4" />}
            />
            <MetricCard
              label="Events / min"
              value={148}
              delta={5}
              data={[120, 140, 130, 150, 145, 148]}
            />
            <MetricCard
              label="Alerts delivered"
              value="99.4%"
              delta={0.3}
              tone="success"
              icon={<Bell className="size-4" />}
            />
          </div>
        </Section>

        <Section title="Cards, table, empty & skeleton">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Runtime health</CardTitle>
                <CardDescription>Inference capability status</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <StatusIndicator status="ok" label="person-detection · ready" emphasis />
                <StatusIndicator status="warn" label="ppe-detection · loading" emphasis />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Recent detections</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Camera</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Severity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>Lobby</TableCell>
                      <TableCell>person</TableCell>
                      <TableCell>
                        <SeverityBadge severity="medium" dot />
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Dock 3</TableCell>
                      <TableCell>intrusion</TableCell>
                      <TableCell>
                        <SeverityBadge severity="critical" dot />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <EmptyState
              title="No incidents"
              description="All clear across all cameras."
              action={<Button size="sm">Configure rules</Button>}
            />
            <Card>
              <CardContent className="pt-4">
                <TableSkeleton rows={4} />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Camera & detection">
          <div className="grid gap-4 sm:grid-cols-2">
            <CameraTile
              name="Lobby — East"
              status="ok"
              live
              fps={24}
              latencyMs={38}
              media={<div className="size-full bg-gradient-to-br from-surface-2 to-black" />}
              overlay={
                <DetectionOverlay
                  detections={[
                    {
                      id: '1',
                      label: 'person',
                      confidence: 0.84,
                      x: 0.32,
                      y: 0.28,
                      width: 0.22,
                      height: 0.5,
                    },
                  ]}
                />
              }
            />
            <VideoPlayerContainer offline />
          </div>
        </Section>

        <Section title="Incidents, alerts & timeline">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <IncidentCard
                title="Intrusion detected — Zone A"
                severity="critical"
                status="raised"
                cameraName="Dock 3"
                at={Date.now() - 90_000}
                actions={
                  <>
                    <Button size="sm" variant="secondary">
                      Acknowledge
                    </Button>
                    <Button size="sm" variant="ghost">
                      Resolve
                    </Button>
                  </>
                }
              />
              <IncidentCard
                title="Loitering — Aisle 4"
                severity="medium"
                status="acknowledged"
                cameraName="Cam 12"
                at={Date.now() - 600_000}
              />
            </div>
            <div className="space-y-3">
              <NotificationCard
                channel="in-app"
                status="delivered"
                target="ops@tenant"
                at={Date.now() - 60_000}
              />
              <NotificationCard
                channel="webhook"
                status="failed"
                target="https://hooks.example/soc"
                at={Date.now() - 120_000}
                attempts={3}
              />
              <NotificationCard
                channel="in-app"
                status="acked"
                target="supervisor@tenant"
                at={Date.now() - 300_000}
              />
            </div>
          </div>
          <div className="mt-4">
            <FilterBar
              search=""
              onSearchChange={() => {}}
              searchPlaceholder="Search events…"
              actions={
                <Button size="sm" variant="outline">
                  Export
                </Button>
              }
            >
              <Badge variant="outline">severity: all</Badge>
            </FilterBar>
            <Timeline
              className="mt-2"
              items={[
                {
                  id: '1',
                  title: 'Incident raised',
                  severity: 'critical',
                  at: Date.now() - 300_000,
                  description: 'Rule "after-hours intrusion" matched',
                },
                {
                  id: '2',
                  title: 'Acknowledged by operator',
                  severity: 'high',
                  at: Date.now() - 240_000,
                },
                {
                  id: '3',
                  title: 'Alert delivered (webhook)',
                  severity: 'info',
                  at: Date.now() - 180_000,
                },
                { id: '4', title: 'Resolved', severity: 'low', at: Date.now() - 60_000 },
              ]}
            />
          </div>
        </Section>
      </div>
    </TooltipProvider>
  );
}
