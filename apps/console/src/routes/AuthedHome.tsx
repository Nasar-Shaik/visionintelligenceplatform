import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePermission } from '@/app/hooks';
import { useLogout, useSession } from '@/features/auth/useAuth';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/ui';

/**
 * Temporary authenticated landing (P2-1.2) — proves the end-to-end auth flow: session,
 * role→permission expansion, and logout. Replaced by the AppShell + Dashboard in P2-1.3.
 */
export function AuthedHome() {
  const { user, tenantId, permissions } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const canManageRules = usePermission('rule:create');
  const canAckIncidents = usePermission('incident:ack');

  return (
    <main className="mx-auto max-w-lg space-y-4 px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Signed in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">User</span>
            <span className="text-foreground">{user?.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tenant</span>
            <span className="tabular text-foreground">{tenantId}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Roles</span>
            <span className="flex flex-wrap justify-end gap-1">
              {user?.roles.map((r) => (
                <Badge key={r} variant="brand">
                  {r}
                </Badge>
              ))}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">UI gating (sample)</span>
            <span className="flex gap-1">
              <Badge variant={canManageRules ? 'success' : 'neutral'}>rule:create</Badge>
              <Badge variant={canAckIncidents ? 'success' : 'neutral'}>incident:ack</Badge>
            </span>
          </div>
          <p className="text-2xs text-text-subtle">
            {permissions.length} permission pattern(s) granted
          </p>
          <Button
            variant="secondary"
            className="w-full"
            loading={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
            }
          >
            <LogOut />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
