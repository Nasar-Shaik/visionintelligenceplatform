import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Session = the authenticated principal + tenant + permissions + token lifecycle.
 * Global synchronous client state (Redux), distinct from server state (TanStack Query).
 * The access token itself lives in the api layer (in-memory); this slice holds identity
 * + permissions used for deny-by-default nav/action gating.
 */
export type SessionStatus = 'unauthenticated' | 'authenticating' | 'authenticated' | 'expired';

export interface SessionUser {
  id: string;
  email: string;
  displayName?: string;
  roles: string[];
}

export interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  tenantId: string | null;
  /** Effective permission strings (wildcards resolved server-side, mirrored here for UI gating). */
  permissions: string[];
}

const initialState: SessionState = {
  status: 'unauthenticated',
  user: null,
  tenantId: null,
  permissions: [],
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    authenticating(state) {
      state.status = 'authenticating';
    },
    authenticated(
      state,
      action: PayloadAction<{ user: SessionUser; tenantId: string; permissions: string[] }>,
    ) {
      state.status = 'authenticated';
      state.user = action.payload.user;
      state.tenantId = action.payload.tenantId;
      state.permissions = action.payload.permissions;
    },
    expired(state) {
      state.status = 'expired';
    },
    signedOut() {
      return initialState;
    },
  },
});

export const { authenticating, authenticated, expired, signedOut } = sessionSlice.actions;
export const sessionReducer = sessionSlice.reducer;
