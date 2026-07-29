import type { ReactNode } from 'react';
import { Provider as ReduxProvider } from 'react-redux';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { store as defaultStore, type AppStore } from './store';
import { createQueryClient } from './queryClient';

const defaultQueryClient = createQueryClient();

interface ProvidersProps {
  children: ReactNode;
  /** Overridable for tests (isolated store/query client per render). */
  store?: AppStore;
  queryClient?: QueryClient;
}

/** Global providers: Redux (client state) + TanStack Query (server state). */
export function Providers({
  children,
  store = defaultStore,
  queryClient = defaultQueryClient,
}: ProvidersProps) {
  return (
    <ReduxProvider store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ReduxProvider>
  );
}
