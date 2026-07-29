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

export function Alert({ className, variant = 'info', title, children, ...props }: AlertProps) {
  const v = variant ?? 'info';
  const Icon = ICON[v];
  return (
    <div role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[v])} aria-hidden />
      <div className="space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
