import { Construction } from 'lucide-react';
import { PageHeader, EmptyState } from '@/ui';

/**
 * Stub for a nav destination whose feature slice hasn't landed yet — keeps the shell fully
 * navigable. Each feature slice (P2-1.4+) replaces its own route with the real page.
 */
export function PlaceholderPage({ title, slice }: { title: string; slice: string }) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PageHeader title={title} />
      <EmptyState
        icon={Construction}
        title={`${title} — coming in ${slice}`}
        description="This module is part of the Operations Console build and will land in an upcoming slice."
      />
    </div>
  );
}
