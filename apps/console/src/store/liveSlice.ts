import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { EventPriority } from '@vip/contracts';

/**
 * Live buffer — a bounded, newest-first ring of incoming incidents/alerts fed by the
 * realtime feed (SSE via G-5; polling until then). Kept small so the "situational
 * awareness" surfaces (ticker, dashboard) render without touching server-state caches.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'polling';

export interface LiveIncident {
  id: string;
  title: string;
  severity: EventPriority;
  cameraId?: string;
  at: string;
}

const MAX_BUFFER = 50;

export interface LiveState {
  connection: ConnectionState;
  incidents: LiveIncident[];
  unseen: number;
}

const initialState: LiveState = {
  connection: 'disconnected',
  incidents: [],
  unseen: 0,
};

const liveSlice = createSlice({
  name: 'live',
  initialState,
  reducers: {
    connectionChanged(state, action: PayloadAction<ConnectionState>) {
      state.connection = action.payload;
    },
    incidentReceived(state, action: PayloadAction<LiveIncident>) {
      state.incidents.unshift(action.payload);
      if (state.incidents.length > MAX_BUFFER) state.incidents.length = MAX_BUFFER;
      state.unseen += 1;
    },
    markSeen(state) {
      state.unseen = 0;
    },
    clearLive() {
      return initialState;
    },
  },
});

export const { connectionChanged, incidentReceived, markSeen, clearLive } = liveSlice.actions;
export const liveReducer = liveSlice.reducer;
