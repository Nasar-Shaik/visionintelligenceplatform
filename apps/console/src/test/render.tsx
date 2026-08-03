import type { ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { makeStore, type AppStore } from '@/app/store';
import { createQueryClient } from '@/app/queryClient';
import { TooltipProvider } from '@/ui';

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
        {/*
          ⚠️ Mirrors `App.tsx`. Radix tooltips throw without a provider, so a harness that omits it
          makes every tooltip-bearing component untestable — and the failure looks like a component
          bug rather than a harness gap. The test tree matches the real tree.
        */}
        <TooltipProvider delayDuration={200}>
          <MemoryRouter initialEntries={[route]}>
            {path ? (
              <Routes>
                <Route path={path} element={ui} />
              </Routes>
            ) : (
              ui
            )}
          </MemoryRouter>
        </TooltipProvider>
      </Providers>,
      options,
    ),
  };
}
