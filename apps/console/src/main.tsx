import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadBranding } from './app/branding';
import './app/styles/theme.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

/*
 * ⚠️ Branding is resolved *before* the first render, so the login screen carries the customer's
 * name rather than flashing ours and swapping. `loadBranding` never rejects — a missing or
 * malformed file leaves the defaults in place — so the console cannot be prevented from loading by
 * a branding problem.
 */
void loadBranding().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
