/**
 * Raise a real `incident.raised` onto the production backbone — the only honest way to make the
 * Alert Engine produce a delivery. **Runs inside the notify container** (that is where the NATS
 * client and the network live); `notification-lifecycle.mjs` copies it in and invokes it.
 *
 *   node lifecycle-publish.mjs '<incident json>'
 *
 * ⚠️ Nothing here writes to the delivery log. It publishes the same contract the Workflow context
 * publishes, and everything downstream — channel selection, transport, the delivery record, the
 * state transitions — is the product doing its own work. An inserted row would prove nothing.
 */
import { connect } from '/app/packages/messaging/node_modules/@nats-io/transport-node/lib/mod.js';
import { jetstream } from '/app/packages/messaging/node_modules/@nats-io/jetstream/lib/mod.js';

/*
 * One incident, or a whole burst in a single call. ⚠️ The burst form matters: publishing thirty
 * incidents through thirty `docker exec` invocations spaces them ~300 ms apart, the Alert Engine
 * keeps pace effortlessly, and the fan-out is never actually in flight when you look. Handing them
 * over in one connection is what makes the engine busy enough to observe.
 */
/* ⚠️ A burst arrives on **stdin**: three hundred incidents in argv is "argument list too long". */
const raw =
  process.argv[2] ??
  (await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  }));
const parsed = JSON.parse(raw);
const incidents = Array.isArray(parsed) ? parsed : [parsed];

const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://nats:4222' });
const js = jetstream(nc);
const acks = await Promise.all(
  incidents.map((incident) =>
    js.publish(
      `t.${incident.tenantId}.incident.raised`,
      new TextEncoder().encode(JSON.stringify(incident)),
      { msgID: `${incident.tenantId}:${incident.id}:raised` },
    ),
  ),
);
console.log(
  JSON.stringify(
    Array.isArray(parsed)
      ? { published: acks.length }
      : { seq: acks[0].seq, duplicate: acks[0].duplicate },
  ),
);
await nc.drain();
