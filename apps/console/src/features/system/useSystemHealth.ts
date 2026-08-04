import { useQuery } from '@tanstack/react-query';
import { systemApi } from '@/lib/api/system';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The platform's health, polled while the page is being looked at.
 *
 * ### ⚠️ The interval is a budget decision, not a preference
 *
 * Every fetch costs the gateway one fan-out — unless it is inside the server-side cache window, in
 * which case it costs nothing and returns the same `derivedAt`. Fifteen seconds is slower than the
 * cache, so concurrent viewers collapse into one probe, and fast enough that an operator watching a
 * service restart sees it change without reaching for the button.
 *
 * `refetchIntervalInBackground` is left off, so a tab forgotten on a wall display stops polling when
 * it is not visible. A health page that polls forever is itself a small outage.
 *
 * `retry: false` because a failure here **is the answer**. Retrying three times before showing it
 * would hide a gateway outage for the several seconds it matters most.
 */
export function useSystemHealth() {
  return useQuery({
    queryKey: queryKeys.health.system(),
    queryFn: () => systemApi.health(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}
