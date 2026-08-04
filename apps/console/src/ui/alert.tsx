import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

const alertVariants = cva('flex gap-3 rounded-md border p-3 text-sm', {
  variants: {
    variant: {
      info: 'border-brand-border bg-brand-muted/40 text-foreground',
      success: 'border-success-border bg-success-muted/40 text-foreground',
      warning: 'border-warning-border bg-warning-muted/40 text-foreground',
      critical: 'border-critical-border bg-critical-muted/40 text-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

const ICON: Record<NonNullable<VariantProps<typeof alertVariants>['variant']>, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  critical: XCircle,
};

const ICON_COLOR = {
  info: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  critical: 'text-critical',
} as const;

export interface AlertProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}

/**
 * ⚠️ **The ARIA role follows the variant. It used to be `alert` for all four, which was wrong.**
 *
 * `role="alert"` is an *assertive* live region: it interrupts a screen reader mid-sentence. That is
 * right for a failed save and wrong for a paragraph of standing explanation — an informational
 * panel that never changes was being announced as though something had just gone wrong, every time
 * it rendered.
 *
 * So: `critical` and `warning` keep `alert`; `success` becomes `status` (polite — it is worth
 * hearing, at the next pause); `info` gets **no live region at all**, because static prose is read
 * in document order like any other text. Found in P-6.3, when a settings page with one standing
 * note and one validation message announced both as alerts and a test could not tell them apart —
 * which is exactly the confusion a screen-reader user would have had.
 */
const ROLE = {
  info: undefined,
  success: 'status',
  warning: 'alert',
  critical: 'alert',
} as const;

export function Alert({ className, variant = 'info', title, children, ...props }: AlertProps) {
  const v = variant ?? 'info';
  const Icon = ICON[v];
  return (
    <div role={ROLE[v]} className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[v])} aria-hidden />
      <div className="space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
