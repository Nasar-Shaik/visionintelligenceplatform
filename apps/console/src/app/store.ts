import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit';
import { sessionReducer } from '@/store/sessionSlice';
import { uiReducer } from '@/store/uiSlice';
import { liveReducer } from '@/store/liveSlice';
import { filtersReducer } from '@/store/filtersSlice';

/**
 * Listener middleware drives cross-cutting reactions (realtime feed wiring, toast on a
 * new critical incident) without coupling slices. Effects are registered by features.
 */
export const listenerMiddleware = createListenerMiddleware();

/** Build a fresh store — one shared instance for the app, isolated instances per test. */
export function makeStore() {
  return configureStore({
    reducer: {
      session: sessionReducer,
      ui: uiReducer,
      live: liveReducer,
      filters: filtersReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(listenerMiddleware.middleware),
  });
}

export const store = makeStore();

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
