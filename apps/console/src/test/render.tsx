import type { ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { makeStore, type AppStore } from '@/app/store';
import { createQueryClient } from '@/app/queryClient';

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  store?: AppStore;
}

/**
 * Render a component with the full provider stack (isolated store + query client +
 * MemoryRouter) — the standard harness for component/hook tests.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', store = makeStore(), ...options }: RenderWithProvidersOptions = {},
): RenderResult & { store: AppStore } {
  const queryClient = createQueryClient();
  return {
    store,
    ...render(
      <Providers store={store} queryClient={queryClient}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </Providers>,
      options,
    ),
  };
}
