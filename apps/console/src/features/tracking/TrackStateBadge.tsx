import { Badge } from '@/ui';
import { STATE_DESCRIPTION, STATE_LABEL } from './trackPresentation';
import type { TrackState } from './useTracking';

/**
 * The lifecycle state of a track, worded for someone who has not read the contract.
 *
 * ⚠️ Its own file, separate from `trackPresentation.ts`, because that module is pure formatting
 * helpers and mixing a component in with them breaks fast refresh for every page that imports one.
 */
const STATE_VARIANT: Record<TrackState, 'neutral' | 'outline' | 'warning' | 'success'> = {
  created: 'outline',
  tentative: 'outline',
  confirmed: 'success',
  lost: 'warning',
  removed: 'neutral',
};

export function TrackStateBadge({ state }: { state: TrackState }) {
  return (
    <Badge variant={STATE_VARIANT[state]} title={STATE_DESCRIPTION[state]}>
      {STATE_LABEL[state]}
    </Badge>
  );
}
