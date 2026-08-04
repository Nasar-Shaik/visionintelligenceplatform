import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Palette, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { useSession } from '@/features/auth/useAuth';
import { branding, brandContrast } from '@/app/branding';
import { formatTimestamp } from '@/lib/format';
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
  Skeleton,
  toast,
} from '@/ui';
import { useTenant, useUpdateTenant } from './useOrganization';

/**
 * Tenant settings — what this organisation is called, and what it is.
 *
 * ### What is editable, and what is deliberately not
 *
 * The backend supports exactly two mutable fields, and this screen exposes one of them:
 *
 * - **Name** — editable. A label, referenced by nobody, safe to change.
 * - **Status** — ⚠️ **shown read-only.** `TenantStatus` is persisted and **no code path reads it**:
 *   nothing in identity, the gateway or `@vip/tenancy` refuses a request because a tenant is
 *   suspended. A "Suspend this tenant" button would therefore be a control that claims to lock
 *   everybody out and does nothing — the worst kind of control on a security product, and a
 *   straightforward breach of "never present behaviour that has not been verified". Recorded as
 *   L-24 and TD-48; it becomes editable when it is enforced, not before.
 * - **Slug** and **tenant id** — immutable, and shown with the reason. The slug is DNS-safe, used
 *   as a key and namespace prefix, and documented as stable for the life of the tenant.
 *
 * ### Branding is read-only here, and that is not an omission
 *
 * Branding is **runtime configuration** (`/branding.json`, fetched before render, no rebuild). It
 * brands the **deployment**, because it is read before anyone signs in so the login screen can
 * carry it. Per-tenant branding needs the tenant to be knowable *before* authentication — decision
 * D-1 — so an editor here would either write a file that applies to every tenant in the
 * deployment, or write a tenant field nothing reads. This panel therefore shows what is in force,
 * where it comes from, and what it scores against WCAG.
 */
export function SettingsPage() {
  const canRead = usePermission('tenant:read');
  const canEdit = usePermission('tenant:update');
  const { tenantId } = useSession();
  const query = useTenant();

  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="You don't have permission to view this organisation's settings."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <PageHeader
        title="Settings"
        description="What this organisation is called, and how the console is branded."
      />

      {/*
       * ⚠️ `unavailableReason` rather than an empty state. A tenant always exists — a signed-in
       * session without a tenant id means the session is malformed, which is "we could not ask",
       * not "there is nothing here". There is deliberately no empty state on this screen.
       */}
      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        unavailableReason={
          tenantId === null || tenantId === ''
            ? 'This session does not carry a tenant, so its settings cannot be loaded. Sign out and back in.'
            : undefined
        }
        skeleton={
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        }
      >
        {query.data ? <OrganizationCard tenant={query.data} canEdit={canEdit} /> : null}
      </QueryBoundary>

      <BrandingCard />
    </div>
  );
}

function OrganizationCard({
  tenant,
  canEdit,
}: {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  canEdit: boolean;
}) {
  const update = useUpdateTenant();
  const [name, setName] = useState(tenant.name);

  /*
   * ⚠️ Follow the server after a save or a refetch, but never while the administrator is typing.
   * `tenant.updatedAt` changes only when the record does, so this re-seeds the field on a real
   * change and leaves an in-progress edit alone — which is what makes the conflict flow work: a
   * 409 refetches, the field resets to what is actually stored, and the retype is deliberate.
   */
  useEffect(() => {
    setName(tenant.name);
  }, [tenant.updatedAt, tenant.name]);

  const trimmed = name.trim();
  const tooLong = trimmed.length > 200;
  const empty = trimmed.length === 0;
  const dirty = trimmed !== tenant.name;
  const conflict = update.error instanceof ApiRequestError && update.error.status === 409;

  const save = () => {
    update.mutate(
      { name: trimmed, expectedUpdatedAt: tenant.updatedAt },
      {
        onSuccess: (saved) => toast.success(`Renamed to ${saved.name}`),
        /* The 409 is rendered inline below rather than as a toast — it needs reading, not dismissing. */
        onError: (error: Error) => {
          if (!(error instanceof ApiRequestError) || error.status !== 409) {
            toast.error(error.message);
          }
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organisation</CardTitle>
        <CardDescription>
          The name appears in the top bar, in reports and in exported evidence.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {conflict ? (
          <Alert variant="critical">
            <span className="font-medium">
              Someone else changed these settings while you were editing.
            </span>{' '}
            The current values are shown below — reapply your change if you still want it.
          </Alert>
        ) : null}
        {update.isError && !conflict ? (
          <Alert variant="critical">
            {update.error instanceof ApiRequestError
              ? update.error.message
              : 'Could not save the organisation name.'}
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="tenant-name">Organisation name</Label>
          <Input
            id="tenant-name"
            value={name}
            disabled={!canEdit}
            aria-invalid={empty || tooLong}
            aria-describedby="tenant-name-hint"
            onChange={(event) => setName(event.target.value)}
          />
          <p
            id="tenant-name-hint"
            className={empty || tooLong ? 'text-xs text-critical' : 'text-xs text-text-subtle'}
            role={empty || tooLong ? 'alert' : undefined}
          >
            {empty
              ? 'A name is required.'
              : tooLong
                ? `Too long — ${trimmed.length} of 200 characters.`
                : canEdit
                  ? 'Up to 200 characters.'
                  : 'Only an administrator can change this.'}
          </p>
        </div>

        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadOnly
            label="Slug"
            value={tenant.slug}
            hint="Immutable. Used as a key and namespace prefix, so changing it would strand every reference that already spells it."
          />
          <ReadOnly
            label="Tenant ID"
            value={tenant.id}
            hint="Immutable. Quote this when contacting support."
          />
          <ReadOnly
            label="Status"
            value={<StatusValue status={tenant.status} />}
            hint="Read-only. Lifecycle transitions are a control-plane operation, and suspension is not yet enforced by the platform — see Known Limitations L-24."
          />
          <ReadOnly
            label="Created"
            value={formatTimestamp(tenant.createdAt)}
            hint={`Last changed ${formatTimestamp(tenant.updatedAt)}.`}
          />
        </dl>

        {canEdit ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!dirty || update.isPending}
              onClick={() => setName(tenant.name)}
            >
              Discard
            </Button>
            <Button
              size="sm"
              loading={update.isPending}
              disabled={!dirty || empty || tooLong}
              onClick={save}
            >
              Save changes
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusValue({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline">{status}</Badge>
      {status !== 'active' ? (
        <span className="inline-flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="size-3.5" aria-hidden />
          not enforced
        </span>
      ) : null}
    </span>
  );
}

function ReadOnly({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-foreground">{value}</dd>
      <p className="mt-1 text-xs text-text-subtle">{hint}</p>
    </div>
  );
}

/**
 * What the deployment currently looks like, and where that comes from.
 *
 * ⚠️ Every value here is read from the branding actually **in force** — the same object the sidebar,
 * the tab title and the accent tokens were built from. A panel that re-read `branding.json` itself
 * could show a file that failed to parse and was ignored, which is the one thing an administrator
 * needs to be told.
 */
function BrandingCard() {
  const brand = branding();
  const contrast = brandContrast();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Branding</CardTitle>
        <CardDescription>
          Applied at runtime from <code className="font-mono text-xs">/branding.json</code>. Editing
          that file and reloading is the whole process — nothing is rebuilt and nothing is
          redeployed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadOnly
            label="Product name"
            value={brand.productName}
            hint="Sidebar, browser tab and login heading."
          />
          <ReadOnly
            label="Tagline"
            value={brand.productTagline || '—'}
            hint="Second line on the login screen."
          />
          <ReadOnly
            label="Logo"
            value={brand.logoUrl || 'Built-in mark'}
            hint="Same-origin path to an SVG or PNG."
          />
          <ReadOnly
            label="Favicon"
            value={brand.favicon || '—'}
            hint="An emoji is rendered to a data-URI icon at runtime."
          />
        </dl>

        <div className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="size-8 shrink-0 rounded-md border border-border"
              style={{ background: contrast.color !== '' ? contrast.color : 'var(--color-brand)' }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                Accent colour {contrast.color !== '' ? contrast.color : '(built-in)'}
              </p>
              <ContrastLine contrast={contrast} />
            </div>
            <Palette className="size-4 shrink-0 text-text-subtle" aria-hidden />
          </div>
        </div>

        {/*
         * ⚠️ Said plainly rather than left to be discovered. An administrator who assumes this is
         * per-tenant will set a colour for one customer and change it for all of them.
         */}
        <Alert variant="info">
          <span className="font-medium">
            Branding applies to the whole deployment, not to this organisation alone.
          </span>{' '}
          It is loaded before anyone signs in, so the login screen can carry it — which means the
          tenant is not yet known. Per-tenant branding is planned, and depends on identifying the
          tenant before sign-in.
        </Alert>
      </CardContent>
    </Card>
  );
}

function ContrastLine({ contrast }: { contrast: ReturnType<typeof brandContrast> }) {
  if (contrast.color === '') {
    return (
      <p className="text-xs text-text-subtle">
        No colour configured — the built-in accent is in use, which meets WCAG AA by construction.
      </p>
    );
  }
  if (contrast.ratio === undefined) {
    return (
      <p className="text-xs text-critical" role="alert">
        Not a colour this build can parse ({'#rgb'}, {'#rrggbb'} and {'rgb(r g b)'} are accepted).
        Ignored — the built-in accent is in use.
      </p>
    );
  }
  if (!contrast.applied) {
    return (
      <p className="text-xs text-critical" role="alert">
        ⚠️ {contrast.ratio.toFixed(2)}:1 against both light and dark text — below the WCAG AA
        minimum of 4.5:1. <span className="font-medium">Ignored rather than applied</span>, because
        an unreadable button is worse than an unbranded one.
      </p>
    );
  }
  return (
    <p className="inline-flex items-center gap-1.5 text-xs text-status-ok">
      <Check className="size-3.5" aria-hidden />
      {contrast.ratio.toFixed(2)}:1 with {contrast.foreground === 'light' ? 'white' : 'near-black'}{' '}
      text — passes WCAG AA (4.5:1).
    </p>
  );
}
