import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * App-wide toast host (sonner), themed to the SOC surfaces. Mounted once near the
 * root; the listener middleware raises a toast on new critical incidents.
 */
export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="top-right"
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
