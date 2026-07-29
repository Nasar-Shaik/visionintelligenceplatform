import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { authClient } from './authClient';

/**
 * Runs the one-time session bootstrap on app load (silent refresh + principal hydrate) and
 * gates rendering behind a splash until it resolves — so guarded routes never flash the login
 * screen for an already-signed-in user mid-refresh.
 */
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke guard
    started.current = true;
    authClient.bootstrap().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-text-subtle">
        <Loader2 className="size-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  return <>{children}</>;
}
