import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * App-wide toast host (sonner), themed to the SOC surfaces. Mounted once near the
 * root; the listener middleware raises a toast on new critical incidents.
 *
 * ### ⚠️ The width is capped to the viewport, and that was a measured defect
 *
 * On a 390 px phone the toast container painted **16 px past the right edge** — every toast, on
 * every page, cut off. Found on the Settings screen at 390 px and not a Settings bug: the save
 * confirmation, a delivery failure and the critical-incident alert all live here.
 *
 * ⚠️ **Setting sonner's own `--width` did not fix it, and the measurement is why this comment
 * exists.** The custom property was applied — it read back correctly — while the container still
 * computed `width: 390px`, because sonner's mobile rule sets `width: 100%` with a 16 px inset on
 * *both* sides and never consults `--width` on that branch. 100% of the viewport plus a left inset
 * is 16 px of overhang by construction.
 *
 * `max-width` is what actually binds: it applies to the computed width whichever rule produced it.
 * The lesson generalises — the property a library documents is not necessarily the property that
 * governs the case in front of you, and only the computed box says which.
 */
export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="top-right"
      style={{ maxWidth: 'calc(100vw - 2rem)' } as CSSProperties}
      toastOptions={{
        classNames: {
          toast:
            'group border border-border-strong bg-surface-2 text-foreground rounded-md shadow-lg text-sm',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground rounded-sm',
          cancelButton: 'bg-surface-3 text-foreground rounded-sm',
        },
      }}
    />
  );
}

export { toast };
