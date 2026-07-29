import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { Alert, Button, Input, Label } from '@/ui';
import { useLogin, useSession } from './useAuth';

const loginSchema = z.object({
  tenantId: z.string().min(1, 'Tenant is required'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type LoginForm = z.infer<typeof loginSchema>;

interface LocationState {
  from?: { pathname: string };
}

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useSession();
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/';

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { tenantId: '', email: '', password: '' },
  });

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit((values) => {
    login.mutate(values, {
      onSuccess: () => navigate(from, { replace: true }),
    });
  });

  const errorMessage =
    login.error instanceof ApiRequestError
      ? login.error.status === 401
        ? 'Invalid tenant, email, or password.'
        : login.error.message
      : login.error
        ? 'Unable to sign in. Please try again.'
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-lg bg-brand-muted text-brand">
            <ShieldCheck className="size-6" aria-hidden />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-foreground">Operations Console</h1>
            <p className="text-sm text-muted-foreground">Sign in to continue</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          noValidate
          className="space-y-4 rounded-lg border border-border bg-surface-1 p-6"
        >
          {errorMessage ? <Alert variant="critical">{errorMessage}</Alert> : null}

          <div className="space-y-1.5">
            <Label htmlFor="tenantId">Tenant</Label>
            <Input
              id="tenantId"
              autoComplete="organization"
              aria-invalid={!!errors.tenantId}
              {...register('tenantId')}
            />
            {errors.tenantId ? (
              <p className="text-xs text-critical">{errors.tenantId.message}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              aria-invalid={!!errors.email}
              {...register('email')}
            />
            {errors.email ? <p className="text-xs text-critical">{errors.email.message}</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-xs text-critical">{errors.password.message}</p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" loading={login.isPending}>
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
