import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium leading-none whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-2 text-muted-foreground',
        outline: 'border-border-strong bg-transparent text-foreground',
        brand: 'border-brand-border bg-brand-muted text-brand',
        success: 'border-success-border bg-success-muted text-success',
        warning: 'border-warning-border bg-warning-muted text-warning',
        critical: 'border-critical-border bg-critical-muted text-critical',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
