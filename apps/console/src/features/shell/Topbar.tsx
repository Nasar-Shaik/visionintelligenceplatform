import { useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, LogOut, Search, User } from 'lucide-react';
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
import { LiveClock } from './LiveClock';

const CONNECTION_STATUS: Record<ConnectionState, { kind: StatusKind; label: string }> = {
  connected: { kind: 'ok', label: 'Live' },
  polling: { kind: 'ok', label: 'Polling' },
  connecting: { kind: 'warn', label: 'Connecting' },
  disconnected: { kind: 'idle', label: 'Offline' },
};

/** Top bar: tenant context · global search · live clock · feed connection · user menu. */
export function Topbar() {
  const { user, tenantId } = useSession();
  const connection = useAppSelector((s) => s.live.connection);
  const logout = useLogout();
  const navigate = useNavigate();
  const conn = CONNECTION_STATUS[connection];

  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-surface-1 px-4">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Building2 className="size-4" aria-hidden />
        <span className="tabular max-w-40 truncate text-foreground" title={tenantId ?? undefined}>
          {tenantId}
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
