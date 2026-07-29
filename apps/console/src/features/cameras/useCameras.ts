import { useQuery } from '@tanstack/react-query';
import { camerasApi } from '@/lib/api/cameras';
import { queryKeys } from '@/lib/queryKeys';

/** Camera registry list (server state). `refetchInterval` enables dashboard polling. */
export function useCameras(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.cameras.list(),
    queryFn: () => camerasApi.list(),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}
