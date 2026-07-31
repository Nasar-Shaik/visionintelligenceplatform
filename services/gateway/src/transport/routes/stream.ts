/**
 * Transport: the SSE adapter + real-time routes (P2-2 G-5). This is the ONLY G-5 file that knows
 * about Server-Sent Events — it adapts a Node `ServerResponse` to the hub's transport-agnostic
 * `ConnectionSink` (Architect rec 5: a future WebSocket/gRPC adapter drops in beside it without
 * touching StreamHub). The route enforces the connection lifecycle up to `Authorized`:
 *
 *   Connecting → Authenticating (edge token) → Authorized (topic permission filter) → hub.open()
 *
 * then hands the socket to the hub for Subscribed → Streaming → Heartbeat → Closed.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtOptions } from '@vip/auth';
import { principalCan } from '@vip/permissions';
import { StreamTopic, type StreamControl, type StreamEnvelope } from '@vip/contracts';
import { authenticateRequest } from '../edge-auth.js';
import { forbidden } from '../../application/errors.js';
import { TOPIC_PERMISSION } from '../../domain/stream.js';
import {
  StreamConnectionLimitError,
  type ConnectionSink,
  type StreamHub,
} from '../../application/stream-hub.js';

export interface StreamRoutesDeps {
  jwt: JwtOptions;
  hub: StreamHub;
  reconnectRetryMs: number;
}

/** Adapts a Node `ServerResponse` to `ConnectionSink`, serializing frames as SSE. */
class SseConnectionSink implements ConnectionSink {
  #open = true;
  constructor(private readonly res: ServerResponse) {}

  deliver(env: StreamEnvelope): boolean {
    return this.#write(`id: ${env.id}\nevent: ${env.topic}\ndata: ${JSON.stringify(env)}\n\n`);
  }
  deliverControl(ctl: StreamControl): boolean {
    return this.#write(`event: ${ctl.type}\ndata: ${JSON.stringify(ctl)}\n\n`);
  }
  writable(): boolean {
    return this.#open && this.res.writable && !this.res.writableNeedDrain;
  }
  onDrain(cb: () => void): void {
    this.res.once('drain', cb);
  }
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.res.end();
  }
  #write(chunk: string): boolean {
    if (!this.#open || !this.res.writable) return false;
    // `write` returns false when the kernel buffer is full → the hub pauses until 'drain'.
    return this.res.write(chunk);
  }
}

/** Parse the `topics` query into a validated, deduped set (defaults to all topics). */
function requestedTopics(request: FastifyRequest): StreamTopic[] {
  const raw = (request.query as { topics?: string }).topics;
  if (!raw) return [...StreamTopic.options];
  const parsed = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is StreamTopic => StreamTopic.options.includes(t as StreamTopic));
  return [...new Set(parsed)];
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRoutesDeps): void {
  // GET /api/stream — open a multiplexed SSE connection for the caller's tenant.
  app.get('/api/stream', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt); // 401 on missing/invalid token

    const requested = requestedTopics(request);
    const granted = requested.filter((t) => principalCan(claims, TOPIC_PERMISSION[t]));
    if (granted.length === 0) {
      throw forbidden('no permitted stream topics for this principal');
    }

    if (!deps.hub.hasCapacity(claims.tenantId)) {
      return reply.code(429).send({
        success: false,
        error: { code: 'too_many_connections', message: 'stream connection limit reached' },
      });
    }

    // Switch to raw SSE: take over the response, write the event-stream preamble.
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx) so frames flush immediately
    });
    res.write(`retry: ${deps.reconnectRetryMs}\n\n`);
    reply.hijack(); // Fastify no longer manages this response

    const lastEventId =
      (request.headers['last-event-id'] as string | undefined) ??
      (request.query as { lastEventId?: string }).lastEventId;

    // The hub bounds the connection by the configured max-duration, which is set ≤ the access-token
    // TTL so a stream never outlives its token; the client reconnects with a refreshed token (the
    // token-expiration → Reconnecting lifecycle transition). See REALTIME_DELIVERY.md.
    const sink = new SseConnectionSink(res);
    let closed = false;
    try {
      const handle = await deps.hub.open({
        tenantId: claims.tenantId,
        topics: granted,
        lastEventId,
        sink,
      });
      const onClose = (): void => {
        if (closed) return;
        closed = true;
        handle.close();
      };
      request.raw.on('close', onClose);
      request.raw.on('error', onClose);
    } catch (err) {
      if (err instanceof StreamConnectionLimitError) {
        sink.close();
        return;
      }
      throw err;
    }
  });

  // GET /stream/diagnostics — per-connection operational snapshot (Architect rec 2), scoped to the
  // caller's own tenant (isolation). Any authenticated reader of the tenant may view it.
  app.get('/stream/diagnostics', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt);
    if (!principalCan(claims, 'camera:read')) {
      throw forbidden('not permitted to view stream diagnostics');
    }
    return reply.send({
      success: true,
      data: { connections: deps.hub.diagnostics(claims.tenantId) },
    });
  });
}
