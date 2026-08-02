import type { ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { makeStore, type AppStore } from '@/app/store';
import { createQueryClient } from '@/app/queryClient';

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  store?: AppStore;
  /**
   * Route pattern to mount `ui` under, e.g. `/rules/:id`.
   *
   * Without this the component sits directly under the router and `useParams` returns `{}` — so a
   * page that branches on a path parameter silently renders its "no id" branch and a test asserting
   * the other branch fails with a confusing "element not found". Supply it whenever the component
   * reads `useParams`.
   */
  path?: string;
}

/**
 * Render a component with the full provider stack (isolated store + query client +
 * MemoryRouter) — the standard harness for component/hook tests.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', store = makeStore(), path, ...options }: RenderWithProvidersOptions = {},
): RenderResult & { store: AppStore } {
  const queryClient = createQueryClient();
  return {
    store,
    ...render(
      <Providers store={store} queryClient={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          {path ? (
            <Routes>
              <Route path={path} element={ui} />
            </Routes>
          ) : (
            ui
          )}
        </MemoryRouter>
      </Providers>,
      options,
    ),
  };
}
