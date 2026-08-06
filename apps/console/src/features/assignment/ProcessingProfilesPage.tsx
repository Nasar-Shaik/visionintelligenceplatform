import { Layers, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import {
  Alert,
  Badge,
  Card,
  TableSkeleton,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui';
import { useProcessingProfiles } from './useAssignment';

/**
 * **Processing Profiles** — the reusable capability sets a camera is bound to (P-8 Phase 6 §6).
 *
 * ### ⚠️ This page tells operators which profiles their deployment can actually run
 *
 * The deployed runtime advertises one capability today, so most of the seeded catalogue is
 * **unsupported here** and says so. That is the page's main job: an operator sees it before binding a
 * camera, instead of discovering it a week later from an events page that stayed empty.
 *
 * ⚠️ `Unknown` is a third answer and is not styled as a failure. Before any runtime has been
 * observed, nothing is known about what can run — reporting that as "unsupported" would blame the
 * catalogue for a measurement that has not happened.
 */
export function ProcessingProfilesPage() {
  const canRead = usePermission('assignment:read');
  const profiles = useProcessingProfiles();
  const forbidden = profiles.error instanceof ApiRequestError && profiles.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader title="Processing profiles" description="What a camera runs when AI is on." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Processing profiles are available to roles holding assignment:read."
        />
      </div>
    );
  }

  const rows = profiles.data ?? [];
  const unsupported = rows.filter((p) => p.supported === false).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Processing profiles"
        description="Cameras are bound to profiles, never to analytics — so analytics can change without touching assignments."
      />

      {unsupported > 0 ? (
        <Alert>
          {unsupported} of these profiles name a capability no registered runtime advertises. A
          camera cannot be bound to one until a runtime that can run it is registered.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Catalogue</CardTitle>
          <CardDescription>
            Support is measured against what the registered runtimes advertise — not configured.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={profiles.isLoading}
            isError={profiles.isError}
            error={profiles.error}
            skeleton={<TableSkeleton rows={4} />}
          >
            {rows.length === 0 ? (
              <EmptyState icon={Layers} title="No profiles" description="Nothing is seeded yet." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile</TableHead>
                    <TableHead>Capability</TableHead>
                    <TableHead>Frame rate</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead>Supported here</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((profile) => (
                    <TableRow key={profile.id}>
                      <TableCell>
                        <div className="font-medium">{profile.name}</div>
                        <div className="text-xs text-muted-foreground">{profile.description}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {profile.capabilities.join(', ')}
                      </TableCell>
                      <TableCell className="text-sm">
                        {/* ⚠️ `null` is "the deployment's rate", not "zero fps". */}
                        {profile.targetFps === null
                          ? 'Deployment default'
                          : `${profile.targetFps} fps`}
                      </TableCell>
                      <TableCell>
                        <Badge variant={profile.builtIn ? 'neutral' : 'outline'}>
                          {profile.builtIn ? 'Built in' : 'Custom'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {profile.supported === null ? (
                          <Badge variant="outline">Unknown</Badge>
                        ) : profile.supported ? (
                          <Badge variant="success">Supported</Badge>
                        ) : (
                          <Badge variant="critical">No runtime</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
