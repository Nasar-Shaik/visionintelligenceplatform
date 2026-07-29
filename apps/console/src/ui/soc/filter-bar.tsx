import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input } from '@/ui/input';

export interface FilterBarProps {
  /** Search box value + handler (feature slices bind these to URL query params). */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter controls (Select/DropdownMenu instances) rendered inline. */
  children?: ReactNode;
  /** Right-aligned actions (density toggle, refresh, export). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Consistent list toolbar: search + filter controls + actions. Presentational — the
 * feature that uses it owns the URL-query wiring (state strategy §11).
 */
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  children,
  actions,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 pb-3', className)}>
      {onSearchChange ? (
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
            aria-hidden
          />
          <Input
            value={search ?? ''}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
            aria-label="Search"
          />
        </div>
      ) : null}
      {children}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
