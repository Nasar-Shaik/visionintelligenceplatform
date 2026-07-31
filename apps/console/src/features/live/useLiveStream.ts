/**
 * useLiveStream (P2-2 G-5) — mounts once in the authenticated shell. It opens the gateway SSE feed,
 * mirrors connection state into the `live` slice (for the Topbar indicator), pushes incidents into
 * the live buffer, and invalidates the relevant TanStack Query caches on each push so open views
 * refetch immediately. Polling in the feature hooks remains the fallback; this only accelerates it.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventPriority, StreamEnvelope } from '@vip/contracts';
import { useAppDispatch } from '@/app/hooks';
import { getAccessToken } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';
import { connectionChanged, incidentReceived } from '@/store/liveSlice';
import { LiveStreamClient, type LiveConnectionState, type StreamFrame } from './streamClient';

const STATE_MAP: Record<LiveConnectionState, 'connecting' | 'connected' | 'polling'> = {
  connecting: 'connecting',
  connected: 'connected',
  polling: 'polling',
};

const SEVERITIES: EventPriority[] = ['critical', 'high', 'medium', 'low', 'info'];
function asSeverity(v: unknown): EventPriority {
  return typeof v === 'string' && (SEVERITIES as string[]).includes(v)
    ? (v as EventPriority)
    : 'info';
}

export function useLiveStream(): void {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Under test the SSE feed is exercised directly in streamClient.test.ts; skip the live network
    // connection here so component/hook tests don't open a real stream (MSW errors on unhandled).
    if (import.meta.env.MODE === 'test') return;

    const client = new LiveStreamClient({
      topics: ['incidents', 'alerts', 'events', 'system'],
      getToken: getAccessToken,
      handlers: {
        onState: (state) => dispatch(connectionChanged(STATE_MAP[state])),
        onFrame: (frame) => handleFrame(frame),
      },
    });

    function handleFrame(frame: StreamFrame): void {
      if (frame.event === 'ready' || frame.event === 'heartbeat' || frame.event === 'error') return;
      let env: StreamEnvelope;
      try {
        env = JSON.parse(frame.data) as StreamEnvelope;
      } catch {
        return;
      }
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      switch (env.topic) {
        case 'incidents': {
          dispatch(
            incidentReceived({
              id: String(payload.incidentId ?? payload.id ?? env.id),
              title: String(payload.title ?? env.type),
              severity: asSeverity(payload.severity),
              ...(payload.cameraId ? { cameraId: String(payload.cameraId) } : {}),
              at: env.occurredAt,
            }),
          );
          void queryClient.invalidateQueries({ queryKey: queryKeys.incidents.all() });
          break;
        }
        case 'alerts':
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
          break;
        case 'events':
        case 'system':
          void queryClient.invalidateQueries({ queryKey: queryKeys.events.all() });
          break;
      }
    }

    client.start();
    return () => {
      client.stop();
      dispatch(connectionChanged('disconnected'));
    };
  }, [dispatch, queryClient]);
}
