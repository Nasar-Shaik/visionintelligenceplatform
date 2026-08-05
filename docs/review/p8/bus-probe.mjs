/**
 * P-8 Phase 5 · a bus probe that runs **inside** a service container.
 *
 *   docker cp bus-probe.mjs vip-prod-media-1:/tmp/bus-probe.mjs
 *   echo '{"op":"publish","messages":[…]}' | docker exec -i vip-prod-media-1 node /tmp/bus-probe.mjs
 *
 * Reads one job as JSON on stdin, prints one JSON result on stdout. Nothing else — no logging to
 * stdout, because the caller parses it.
 *
 * ### Why a probe rather than a host-side client
 *
 * NATS is not published to the host in the production compose file, and it should not be: the
 * backbone is an internal service and exposing it to make a test easier would weaken the deployment
 * to verify it. So the probe runs where the services run, on the same network, through the **same
 * frozen `@vip/messaging` adapter the publisher itself uses** — which is the point. A verification
 * that reached the broker through a different client would be measuring a different code path than
 * the one production takes.
 *
 * ### ⚠️ It publishes and it reads counters. It never subscribes.
 *
 * A durable consumer left behind by a verification run is a permanent, invisible drag on a stream —
 * it holds redelivery state for messages nobody will ever ack. Stream depth comes from the NATS
 * monitoring endpoint instead, which is a read and leaves nothing.
 *
 * `msgId` is passed through deliberately: it is the platform's transport idempotency key, and the
 * whole duplicate verification turns on being able to send the same body with the same key and then
 * with a different one.
 */
import { readFileSync } from 'node:fs';

/** The built adapter inside the container image. Overridable for a differently-laid-out image. */
const MESSAGING = process.env.VIP_MESSAGING ?? '/app/packages/messaging/dist/index.js';
/** NATS monitoring (`-m 8222`), used only for read-only stream counters. */
const MONITOR = process.env.VIP_NATS_MONITOR ?? 'http://nats:8222';

const { NatsEventBus } = await import(MESSAGING);

const job = JSON.parse(readFileSync(0, 'utf8'));

/** Stream depths, keyed by stream name — a read-only counter, not a subscription. */
async function streams() {
  const res = await fetch(`${MONITOR}/jsz?streams=1`);
  if (!res.ok) throw new Error(`nats monitoring returned ${res.status}`);
  const body = await res.json();
  const out = {};
  for (const account of body.account_details ?? []) {
    for (const stream of account.stream_detail ?? []) {
      out[stream.name] = stream.state?.messages ?? 0;
    }
  }
  return out;
}

async function main() {
  if (job.op === 'streams') return { streams: await streams() };

  if (job.op === 'publish') {
    const bus = await NatsEventBus.connect({ servers: process.env.NATS_URL, name: 'p8-bus-probe' });
    try {
      const published = [];
      for (const message of job.messages) {
        await bus.publish(
          message.subject,
          message.body,
          message.msgId === undefined ? undefined : { msgId: message.msgId },
        );
        published.push({ subject: message.subject, msgId: message.msgId ?? null });
      }
      /*
       * ⚠️ The counters are read AFTER publishing, on the same connection, so a caller comparing a
       * before/after pair is comparing two settled reads rather than racing its own publish.
       */
      return { published, streams: await streams() };
    } finally {
      await bus.close?.();
    }
  }

  throw new Error(`unknown op: ${JSON.stringify(job.op)}`);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
  process.exit(0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
}
