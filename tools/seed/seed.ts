/**
 * Development bootstrap seed.
 *
 * Writes a minimal, self-consistent dataset straight into MongoDB so a developer can log into the
 * Operations Console immediately after `pnpm dev:stack`. It talks to Mongo directly (not through the
 * services) on purpose: it needs no running services and no NATS, so it works before `pnpm dev:all`.
 *
 * The document shapes mirror each service's persistence layer (collections `tenants`, `org_nodes`,
 * `users`, `cameras`, `rules`, `rule_versions`, `events`, `incidents`, `notifications`) and the
 * `@vip/contracts` schemas. The admin password is hashed with the same `@vip/auth` KDF the identity
 * service uses, so login verifies correctly.
 *
 * Idempotent: every document is upserted on a stable key, so re-running is safe.
 *
 *   pnpm dev:stack   # Mongo must be up
 *   pnpm seed
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { hashPassword } from '@vip/auth';
import { loadDotEnv } from '@vip/config';

// Load the repo-root .env regardless of where the script is invoked from.
const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
loadDotEnv(ROOT_ENV);

const MONGO_URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip?authSource=admin';

// --- default dev credentials (documented in docs/setup/DEMO.md) ---
const TENANT_ID = 'tnt_dev';
const TENANT_SLUG = 'dev';
const ADMIN_EMAIL = 'admin@vip.dev';
const ADMIN_PASSWORD = 'DevPassw0rd!';

// Stable ids so re-seeding replaces rather than duplicates.
const ORG_ID = 'org_dev_root';
const USER_ID = 'usr_dev_admin';
const CAMERA_ID = 'cam_dev_1';
const RULE_ID = 'rule_dev_1';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const INCIDENT_ID = '00000000-0000-4000-8000-0000000000c1';
const CANDIDATE_ID = '00000000-0000-4000-8000-0000000000a1';
const NOTIFICATION_ID = '00000000-0000-4000-8000-0000000000f1';
const CHANNEL_ID = 'chan_dev_inapp';
const CORRELATION_ID = 'corr_dev_1';

const NOW = new Date();
const iso = (d: Date) => d.toISOString();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function main(): Promise<void> {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    // Honour the database named in the connection string (dev default: `vip`).
    const db = client.db();
    console.log(`→ seeding database "${db.databaseName}" via ${redact(MONGO_URI)}\n`);

    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const now = iso(NOW);

    // 1) Tenant (active) ------------------------------------------------------
    await upsert(
      db,
      'tenants',
      { _id: TENANT_ID },
      {
        _id: TENANT_ID,
        tenantId: TENANT_ID,
        slug: TENANT_SLUG,
        name: 'Dev Tenant',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    );

    // 2) Organization root ----------------------------------------------------
    await upsert(
      db,
      'org_nodes',
      { _id: ORG_ID },
      {
        _id: ORG_ID,
        tenantId: TENANT_ID,
        parentId: null,
        type: 'org',
        name: 'Dev Organization',
        path: [],
        createdAt: now,
        updatedAt: now,
      },
    );

    // 3) Admin user (login target) -------------------------------------------
    await upsert(
      db,
      'users',
      { _id: USER_ID },
      {
        _id: USER_ID,
        tenantId: TENANT_ID,
        email: ADMIN_EMAIL.toLowerCase(),
        passwordHash,
        roles: ['admin'],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    );

    // 4) Sample camera --------------------------------------------------------
    await upsert(
      db,
      'cameras',
      { _id: CAMERA_ID },
      {
        _id: CAMERA_ID,
        tenantId: TENANT_ID,
        zoneId: ORG_ID,
        name: 'Front Entrance',
        protocol: 'rtsp',
        streamUrl: 'rtsp://demo.local:8554/front-entrance',
        status: 'enabled',
        capture: { ptz: false },
        health: { status: 'online' },
        credentialCipher: null,
        createdAt: now,
        updatedAt: now,
      },
    );

    // 5) Sample rule (+ version record) --------------------------------------
    const rule = {
      id: RULE_ID,
      tenantId: TENANT_ID,
      name: 'Person detected — Front Entrance',
      description: 'Raise a high-severity incident when a person is detected with high confidence.',
      lifecycle: 'enabled',
      priority: 100,
      version: 1,
      eventTypes: ['perception.person.detected'],
      categories: ['perception'],
      condition: { all: [{ field: 'confidence', op: 'gte', value: 0.8 }] },
      severity: 'high',
      actions: [{ type: 'raise-incident' }],
      createdAt: now,
      updatedAt: now,
      createdBy: USER_ID,
    };
    await upsert(db, 'rules', { id: RULE_ID, tenantId: TENANT_ID }, rule);
    await upsert(
      db,
      'rule_versions',
      { ruleId: RULE_ID, version: 1, tenantId: TENANT_ID },
      {
        tenantId: TENANT_ID,
        ruleId: RULE_ID,
        version: 1,
        changeKind: 'created',
        changedBy: USER_ID,
        changedAt: now,
        snapshot: rule,
      },
    );

    // 6) Sample event ---------------------------------------------------------
    const occurredAt = iso(minsAgo(6));
    await upsert(
      db,
      'events',
      { id: EVENT_ID, tenantId: TENANT_ID },
      {
        id: EVENT_ID,
        type: 'perception.person.detected',
        envelopeVersion: '1.0.0',
        category: 'perception',
        schemaVersion: '1.0.0',
        tenantId: TENANT_ID,
        cameraId: CAMERA_ID,
        zoneId: ORG_ID,
        occurredAt,
        ingestedAt: occurredAt,
        producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
        confidence: 0.92,
        subjects: [{ class: 'person' }],
        correlationId: CORRELATION_ID,
        payload: {},
        evidenceRefs: [],
        priority: 'high',
        dedupKey: `${TENANT_ID}:${EVENT_ID}`,
      },
    );

    // 7) Sample incident (raised) --------------------------------------------
    const raisedAt = iso(minsAgo(5));
    await upsert(
      db,
      'incidents',
      { id: INCIDENT_ID, tenantId: TENANT_ID },
      {
        id: INCIDENT_ID,
        tenantId: TENANT_ID,
        status: 'raised',
        severity: 'high',
        title: 'Person detected — Front Entrance',
        category: 'perception',
        source: {
          ruleId: RULE_ID,
          ruleVersion: 1,
          ruleName: rule.name,
          candidateId: CANDIDATE_ID,
          dedupKey: `${TENANT_ID}:${RULE_ID}:${EVENT_ID}`,
        },
        triggeredBy: {
          eventId: EVENT_ID,
          eventType: 'perception.person.detected',
          cameraId: CAMERA_ID,
          zoneId: ORG_ID,
          occurredAt,
        },
        matchedCount: 1,
        version: 1,
        correlationId: CORRELATION_ID,
        causationId: CANDIDATE_ID,
        history: [{ from: null, to: 'raised', at: raisedAt, by: 'system' }],
        raisedAt,
        updatedAt: raisedAt,
      },
    );

    // 8) Sample alert (in-app channel + delivered notification) ---------------
    await upsert(
      db,
      'notification_channels',
      { _id: CHANNEL_ID },
      {
        _id: CHANNEL_ID,
        tenantId: TENANT_ID,
        name: 'In-app inbox',
        type: 'in-app',
        config: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    );
    const deliveredAt = iso(minsAgo(5));
    await upsert(
      db,
      'notifications',
      { id: NOTIFICATION_ID, tenantId: TENANT_ID },
      {
        id: NOTIFICATION_ID,
        tenantId: TENANT_ID,
        incidentId: INCIDENT_ID,
        channelId: CHANNEL_ID,
        channelType: 'in-app',
        status: 'delivered',
        severity: 'high',
        title: 'Person detected — Front Entrance',
        correlationId: CORRELATION_ID,
        causationId: INCIDENT_ID,
        attempts: 1,
        sentAt: deliveredAt,
        deliveredAt,
        createdAt: deliveredAt,
        updatedAt: deliveredAt,
      },
    );

    console.log('✔ Seed complete.\n');
    console.log('  Log in to the Operations Console (http://localhost:5173):');
    console.log(`    Tenant:   ${TENANT_ID}`);
    console.log(`    Email:    ${ADMIN_EMAIL}`);
    console.log(`    Password: ${ADMIN_PASSWORD}\n`);
    console.log(
      '  Seeded: 1 tenant · 1 org · 1 admin · 1 camera · 1 rule · 1 event · 1 incident · 1 alert',
    );
  } finally {
    await client.close();
  }
}

async function upsert(
  db: import('mongodb').Db,
  collection: string,
  filter: Record<string, unknown>,
  doc: Record<string, unknown>,
): Promise<void> {
  await db.collection(collection).replaceOne(filter, doc, { upsert: true });
  console.log(`  • ${collection.padEnd(22)} ${JSON.stringify(filter)}`);
}

/** Hide the password in a Mongo URI for logging. */
function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
}

main().catch((err: unknown) => {
  console.error('\n✖ Seed failed:', err instanceof Error ? err.message : err);
  console.error('  Is the dev stack up? Run: pnpm dev:stack');
  process.exit(1);
});
