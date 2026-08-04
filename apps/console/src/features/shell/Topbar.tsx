import { Link, useNavigate } from 'react-router-dom';
import { Bell, Building2, ChevronDown, LogOut, Search, User } from 'lucide-react';
import { useAppSelector } from '@/app/hooks';
import { useLogout, useSession } from '@/features/auth/useAuth';
import { cn } from '@/lib/cn';
import type { ConnectionState } from '@/store/liveSlice';
import type { StatusKind } from '@/lib/status';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  StatusIndicator,
} from '@/ui';
import { useTenant } from '@/features/organization/useOrganization';
import { useInboxCount } from '@/features/alerts/useNotifications';
import { LiveClock } from './LiveClock';

const CONNECTION_STATUS: Record<ConnectionState, { kind: StatusKind; label: string }> = {
  connected: { kind: 'ok', label: 'Live' },
  polling: { kind: 'ok', label: 'Polling' },
  connecting: { kind: 'warn', label: 'Connecting' },
  disconnected: { kind: 'idle', label: 'Offline' },
};

/** Top bar: tenant context · global search · inbox · live clock · feed connection · user menu. */
export function Topbar() {
  const { user, tenantId } = useSession();
  const connection = useAppSelector((s) => s.live.connection);
  const logout = useLogout();
  const navigate = useNavigate();
  const conn = CONNECTION_STATUS[connection];
  /*
   * ⚠️ The **organisation name**, not the raw tenant id. This read `tnt_demo_retail`, which is an
   * internal identifier a customer never chose and cannot change — and it made the Settings page's
   * own description ("the name appears in the top bar") untrue, which is how it was noticed.
   *
   * The id is kept as the tooltip: it is what support asks for. The query is the same cached one
   * the Settings page uses, so this costs one request per session and stays correct after a rename
   * because renaming invalidates that key. Falls back to the id while loading, so the bar never
   * flashes empty.
   */
  const tenant = useTenant();
  const organisation = tenant.data?.name ?? tenantId;

  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-surface-1 px-4">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Building2 className="size-4" aria-hidden />
        <span className="max-w-40 truncate text-foreground" title={tenantId ?? undefined}>
          {organisation}
        </span>
      </div>

      <div className="relative mx-auto hidden w-full max-w-md md:block">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
          aria-hidden
        />
        <Input
          placeholder="Search cameras, incidents, events…"
          className="pl-8"
          aria-label="Global search"
        />
      </div>

      <div className="ml-auto flex items-center gap-4">
        <InboxBell />
        <LiveClock />
        <StatusIndicator
          status={conn.kind}
          label={conn.label}
          pulse={conn.kind === 'ok'}
          emphasis
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-muted-foreground">
                <User className="size-3.5" aria-hidden />
              </span>
              <span className="hidden max-w-32 truncate text-sm sm:inline">{user?.email}</span>
              <ChevronDown className="size-3.5 text-text-subtle" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
            <div className="flex flex-wrap gap-1 px-2 pb-1.5">
              {user?.roles.map((r) => (
                <span
                  key={r}
                  className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-2xs text-muted-foreground"
                >
                  {r}
                </span>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <User />
              Profile & settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
              }
              className={cn('text-critical focus:text-critical')}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/**
 * How many incidents are waiting for somebody, wherever you are in the console.
 *
 * ⚠️ **This is what makes the inbox an inbox.** A queue you have to remember to visit is a page; a
 * count that follows you is a queue. Without it an operator working an incident has no way to know
 * that three more arrived while they were reading.
 *
 * ⚠️ **Silent when it is zero, and silent when it fails.** A bell showing "0" is decoration, and a
 * bell showing "0" *because the request failed* is a lie in the shape of an all-clear — so the badge
 * is absent in both cases and the link stays, which is the only honest thing a shell can do about a
 * number it could not fetch. The page itself reports the failure properly.
 *
 * ⚠️ It reuses the query the inbox page uses, so this costs one request per interval for the whole
 * console rather than one per screen — and acknowledging an alert updates both, because they are the
 * same cache entry.
 */
function InboxBell() {
  const { count, capped, isError } = useInboxCount({ refetchInterval: 30_000 });
  const waiting = isError ? 0 : count;

  return (
    <Button asChild variant="ghost" size="sm" className="relative gap-2 px-2">
      <Link
        to="/alerts"
        aria-label={
          waiting === 0
            ? 'Inbox'
            : `Inbox — ${waiting}${capped ? ' or more' : ''} incident${waiting === 1 ? '' : 's'} waiting`
        }
      >
        <Bell className="size-4" aria-hidden />
        {waiting > 0 ? (
          <span className="min-w-5 rounded-full bg-critical px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-critical-foreground">
            {waiting}
            {capped ? '+' : ''}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}
