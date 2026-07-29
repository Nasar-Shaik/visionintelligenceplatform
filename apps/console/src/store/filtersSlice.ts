import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Cross-page default filters (e.g. a preferred severity floor). Per-view filters live
 * in the URL query string (shareable/reload-safe, §11); this slice only holds the
 * app-wide defaults a new view starts from.
 */
export interface FiltersState {
  defaultSeverityFloor: 'critical' | 'high' | 'medium' | 'low' | 'info' | null;
}

const initialState: FiltersState = {
  defaultSeverityFloor: null,
};

const filtersSlice = createSlice({
  name: 'filters',
  initialState,
  reducers: {
    setDefaultSeverityFloor(state, action: PayloadAction<FiltersState['defaultSeverityFloor']>) {
      state.defaultSeverityFloor = action.payload;
    },
  },
});

export const { setDefaultSeverityFloor } = filtersSlice.actions;
export const filtersReducer = filtersSlice.reducer;
