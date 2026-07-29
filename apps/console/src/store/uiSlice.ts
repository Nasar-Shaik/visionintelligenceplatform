import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/** App-wide presentation preferences (dark-only theme for P2-1; density-aware tables). */
export type Density = 'compact' | 'comfortable';

export interface UiState {
  theme: 'dark';
  sidebarCollapsed: boolean;
  density: Density;
}

const initialState: UiState = {
  theme: 'dark',
  sidebarCollapsed: false,
  density: 'compact',
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
    setDensity(state, action: PayloadAction<Density>) {
      state.density = action.payload;
    },
  },
});

export const { toggleSidebar, setSidebarCollapsed, setDensity } = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
