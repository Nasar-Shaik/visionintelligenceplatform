import { useMemo, useState } from 'react';
import { KeyRound, ShieldOff, ShieldCheck, UserPlus, Users2 } from 'lucide-react';
import type { User } from '@vip/contracts';
import { ROLES } from '@vip/permissions';
import { usePermission } from '@/app/hooks';
import { useSession } from '@/features/auth/useAuth';
import { formatTimestamp, timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusIndicator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
  toast,
} from '@/ui';
import {
  useCreateUser,
  useDisableUser,
  useEnableUser,
  useSetUserPassword,
  useUpdateUser,
  useUsers,
} from './useUsers';

/**
 * Who can sign in, and what they are allowed to do.
 *
 * This screen exists because of one sentence in the pilot readiness review: *an offboarded employee
 * keeps access to a security product*. Until P-6.2 a user could be created and listed and nothing
 * else — no way to change a role, no way to take access away. That is the whole reason it is here,
 * and it is why **Disable** is the primary action on every row rather than something behind a menu.
 *
 * ⚠️ Nobody is deleted. Incidents name their assignee, evidence names who attached it, and the
 * access audit names who looked; a deleted row turns all of that into a dangling id. Disabling ends
 * access and keeps the history true.
 */
export function UsersPage() {
  const query = useUsers();
  const canManage = usePermission('user:update');
  const canCreate = usePermission('user:create');
  const [creating, setCreating] = useState(false);
  const [editingRoles, setEditingRoles] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [disabling, setDisabling] = useState<User | null>(null);

  const users = useMemo(() => query.data ?? [], [query.data]);
  const activeCount = users.filter((u) => u.status === 'active').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Who can sign in to this tenant, and what each of them is allowed to do."
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <UserPlus className="size-4" aria-hidden />
              Add user
            </Button>
          ) : null
        }
      />

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={users.length === 0}
        skeleton={<TableSkeleton rows={5} cols={5} />}
        emptyState={
          <EmptyState
            icon={Users2}
            title="No users yet"
            description="Add the people who need access. Everyone signs in with their own account — shared logins make an audit trail meaningless."
          />
        }
      >
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {activeCount} active of {users.length}
          </p>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last changed</TableHead>
                {canManage ? (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  canManage={canManage}
                  onEditRoles={() => setEditingRoles(user)}
                  onResetPassword={() => setResetting(user)}
                  onDisable={() => setDisabling(user)}
                />
              ))}
            </TableBody>
          </Table>
        </>
      </QueryBoundary>

      {creating ? <AddUserDialog onDone={() => setCreating(false)} /> : null}
      {editingRoles ? (
        <EditRolesDialog user={editingRoles} onDone={() => setEditingRoles(null)} />
      ) : null}
      {resetting ? (
        <ResetPasswordDialog user={resetting} onDone={() => setResetting(null)} />
      ) : null}
      {disabling ? <DisableDialog user={disabling} onDone={() => setDisabling(null)} /> : null}
    </div>
  );
}

function UserRow({
  user,
  canManage,
  onEditRoles,
  onResetPassword,
  onDisable,
}: {
  user: User;
  canManage: boolean;
  onEditRoles: () => void;
  onResetPassword: () => void;
  onDisable: () => void;
}) {
  const session = useSession();
  const enable = useEnableUser();
  const isSelf = session.user?.id === user.id;
  const disabled = user.status === 'disabled';

  return (
    <TableRow className={disabled ? 'opacity-60' : undefined}>
      <TableCell className="font-medium text-foreground">
        {user.email}
        {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          {user.roles.length > 0 ? (
            user.roles.map((role) => (
              <Badge key={role} variant="outline">
                {role}
              </Badge>
            ))
          ) : (
            /* A user with no role can sign in and do nothing. Worth showing, not hiding. */
            <span className="text-muted-foreground">No role</span>
          )}
        </span>
      </TableCell>
      <TableCell>
        <StatusIndicator
          status={user.status === 'active' ? 'ok' : disabled ? 'error' : 'idle'}
          label={disabled ? 'Disabled' : user.status === 'invited' ? 'Invited' : 'Active'}
        />
      </TableCell>
      <TableCell
        className="whitespace-nowrap text-muted-foreground"
        title={formatTimestamp(user.updatedAt)}
      >
        {timeAgo(user.updatedAt)}
      </TableCell>
      {canManage ? (
        <TableCell>
          <span className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={onEditRoles}>
              Roles
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetPassword}
              aria-label={`Reset the password for ${user.email}`}
            >
              <KeyRound className="size-4" aria-hidden />
            </Button>
            {disabled ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={enable.isPending}
                aria-label={`Re-enable ${user.email}`}
                onClick={() =>
                  enable.mutate(user.id, {
                    onSuccess: () =>
                      toast.success(`${user.email} can sign in again`, {
                        description: 'Their password is unchanged. Old sessions stay revoked.',
                      }),
                    onError: (error: Error) => toast.error(error.message),
                  })
                }
              >
                <ShieldCheck className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                /* ⚠️ You cannot disable yourself — the server refuses it too. Disabled rather
                   than hidden, so the reason is discoverable instead of the button just missing. */
                disabled={isSelf}
                title={isSelf ? 'You cannot disable your own account' : undefined}
                aria-label={`Disable ${user.email}`}
                onClick={onDisable}
              >
                <ShieldOff className="size-4" aria-hidden />
              </Button>
            )}
          </span>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/**
 * Confirm before taking someone's access away.
 *
 * The confirmation spells out the two consequences that are not obvious from the button: open
 * sessions end, and the account is kept rather than removed. An administrator should never have to
 * find out either of those by trying it.
 */
function DisableDialog({ user, onDone }: { user: User; onDone: () => void }) {
  const disable = useDisableUser();

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable {user.email}?</DialogTitle>
          <DialogDescription>
            They will be signed out everywhere and will not be able to sign in again until you
            re-enable them. Nothing is deleted — their name stays on the incidents and evidence they
            handled.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={disable.isPending}
            onClick={() =>
              disable.mutate(user.id, {
                onSuccess: (result) => {
                  toast.success(`${user.email} disabled`, {
                    description:
                      result.sessionsRevoked > 0
                        ? `${result.sessionsRevoked} active session(s) ended.`
                        : 'They had no active sessions.',
                  });
                  onDone();
                },
                onError: (error: Error) => toast.error(error.message),
              })
            }
          >
            {disable.isPending ? 'Disabling…' : 'Disable'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Change what someone is allowed to do.
 *
 * One role per user, which is what the role model actually supports today: the contract carries an
 * array, but every canonical role is a superset of the one below it, so two of them means the wider
 * one. Offering a multi-select would imply a combination the PDP does not distinguish.
 */
function EditRolesDialog({ user, onDone }: { user: User; onDone: () => void }) {
  const update = useUpdateUser();
  const [role, setRole] = useState<string>(user.roles[0] ?? 'viewer');

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Role for {user.email}</DialogTitle>
          <DialogDescription>
            Takes effect the next time their access token is renewed — within 15 minutes, or
            immediately if they sign in again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="user-role">Role</Label>
          {/* Mounted with the value already known — see the P-6.1 note in `RuleEditorPage`. */}
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="user-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {ROLE_LABEL[option] ?? option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTION[role] ?? ''}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={update.isPending || role === (user.roles[0] ?? '')}
            onClick={() =>
              update.mutate(
                { userId: user.id, patch: { roles: [role] } },
                {
                  onSuccess: () => {
                    toast.success(`${user.email} is now ${ROLE_LABEL[role] ?? role}`);
                    onDone();
                  },
                  onError: (error: Error) => toast.error(error.message),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Set a password on someone else's behalf. Ends their sessions, because a reset that leaves the
 *  suspect session running is ceremonial. */
function ResetPasswordDialog({ user, onDone }: { user: User; onDone: () => void }) {
  const reset = useSetUserPassword();
  const [password, setPassword] = useState('');
  const tooShort = password.length > 0 && password.length < 8;

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a password for {user.email}</DialogTitle>
          <DialogDescription>
            They will be signed out everywhere. Tell them the new password over a channel they
            already trust, and ask them to change it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="new-password-hint"
            aria-invalid={tooShort}
          />
          <p
            id="new-password-hint"
            className={tooShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            role={tooShort ? 'alert' : undefined}
          >
            At least 8 characters.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={password.length < 8 || reset.isPending}
            onClick={() =>
              reset.mutate(
                { userId: user.id, password },
                {
                  onSuccess: (result) => {
                    toast.success(`Password set for ${user.email}`, {
                      description:
                        result.sessionsRevoked > 0
                          ? `${result.sessionsRevoked} active session(s) ended.`
                          : undefined,
                    });
                    onDone();
                  },
                  onError: (error: Error) => toast.error(error.message),
                },
              )
            }
          >
            {reset.isPending ? 'Setting…' : 'Set password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({ onDone }: { onDone: () => void }) {
  const create = useCreateUser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const valid = /.+@.+\..+/.test(email) && password.length >= 8;

  return (
    <Dialog open onOpenChange={(next) => !next && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>
            The address is how they sign in, and it cannot be changed afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-user-email">Email</Label>
            <Input
              id="new-user-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="operator@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-user-password">Temporary password</Label>
            <Input
              id="new-user-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby="new-user-password-hint"
            />
            <p id="new-user-password-hint" className="text-xs text-muted-foreground">
              At least 8 characters.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-user-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="new-user-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ROLE_LABEL[option] ?? option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTION[role] ?? ''}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={() =>
              create.mutate(
                { email: email.trim().toLowerCase(), password, roles: [role] },
                {
                  onSuccess: () => {
                    toast.success(`${email.trim().toLowerCase()} added`);
                    onDone();
                  },
                  onError: (error: Error) => toast.error(error.message),
                },
              )
            }
          >
            Add user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Role names as a customer reads them, and what each one actually grants.
 *
 * ⚠️ The descriptions are written from `ROLE_PERMISSIONS`, not from an idea of what the roles
 * ought to mean. If a grant changes there, this text is wrong and must change with it.
 */
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_DESCRIPTION: Record<string, string> = {
  owner: 'Everything an administrator can do, and nothing is withheld.',
  admin: 'Manages users, cameras, locations and rules. Can inspect who accessed what.',
  operator: 'Works incidents: acknowledge, investigate, attach evidence, escalate, resolve, close.',
  viewer: 'Reads everything in the tenant. Changes nothing.',
};
