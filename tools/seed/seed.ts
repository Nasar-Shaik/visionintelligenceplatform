/**
 * Development bootstrap seed.
 *
 * Writes a minimal, self-consistent dataset straight into MongoDB so a developer can log into the
 * Operations Console immediately after `pnpm dev:stack`. It talks to Mongo directly (not through the
 * services) on purpose: it needs no running services and no NATS, so it works before `pnpm dev:all`.
 *
 * The document shapes mirror each service's persistence layer (collections `tenants`, `org_nodes`,
 * `users`, `cameras`, `rules`, `rule_versions`, `events`, `incidents`, `notifications`) and the
 * `@vip/contracts` schemas. It seeds one user per role (owner/admin/operator/viewer) so every
 * permission tier can be exercised; each password is hashed with the same `@vip/auth` KDF the
 * identity service uses, so login verifies correctly.
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

// One simple password for every seeded dev account (DEV ONLY — never use anything like this in a
// real environment). Login accepts it because LoginInput only requires a non-empty password; the
// stronger min-length rule applies to user *creation* via the API, which the seed bypasses.
const DEV_PASSWORD = '123456';

/**
 * ⚠️ The seed is the documented bootstrap step for a *production* deployment too
 * (`docker compose --profile seed run --rm seed`), which made this hard-coded password a way to
 * stand up a real system with `123456` on an owner account. Found in P-5.8 by running the
 * production bootstrap and reading what it printed.
 *
 * So it now fails closed: under `NODE_ENV=production` a strong `SEED_PASSWORD` is required, and the
 * dev default is refused outright. Development is untouched — no variable, same password as always.
 */
const MIN_PRODUCTION_PASSWORD_LENGTH = 12;

function resolveSeedPassword(env: NodeJS.ProcessEnv): string {
  const supplied = env.SEED_PASSWORD;
  if (env.NODE_ENV !== 'production')
    return supplied && supplied.length > 0 ? supplied : DEV_PASSWORD;

  if (supplied === undefined || supplied.length === 0) {
    throw new Error(
      'SEED_PASSWORD must be set when NODE_ENV=production — refusing to seed accounts with the development password.',
    );
  }
  if (supplied === DEV_PASSWORD || supplied.length < MIN_PRODUCTION_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_PASSWORD is too weak for a production seed (needs ${MIN_PRODUCTION_PASSWORD_LENGTH}+ characters and must not be the development default).`,
    );
  }
  return supplied;
}

const SEED_PASSWORD = resolveSeedPassword(process.env);
const PASSWORD_FROM_ENV = SEED_PASSWORD !== DEV_PASSWORD;

// One account per role, so you can log in and exercise each permission tier (deny-by-default gating).
const USERS = [
  { id: 'usr_dev_owner', email: 'owner@vip.dev', roles: ['owner'] },
  { id: 'usr_dev_admin', email: 'admin@vip.dev', roles: ['admin'] },
  { id: 'usr_dev_operator', email: 'operator@vip.dev', roles: ['operator'] },
  { id: 'usr_dev_viewer', email: 'viewer@vip.dev', roles: ['viewer'] },
];

// The admin user id — used as the author of the seeded rule.
const ADMIN_ID = 'usr_dev_admin';

// Stable ids so re-seeding replaces rather than duplicates.
const ORG_ID = 'org_dev_root';
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

    // 3) Users — one per role (all share DEV_PASSWORD) ------------------------
    for (const user of USERS) {
      await upsert(
        db,
        'users',
        { _id: user.id },
        {
          _id: user.id,
          tenantId: TENANT_ID,
          email: user.email.toLowerCase(),
          passwordHash: await hashPassword(SEED_PASSWORD),
          roles: user.roles,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      );
    }

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
      createdBy: ADMIN_ID,
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
        changedBy: ADMIN_ID,
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
    console.log(
      `  Log in to the Operations Console (${process.env.VIP_PUBLIC_URL ?? 'http://localhost:5173'}):`,
    );
    console.log(`    Tenant:   ${TENANT_ID}`);
    // ⚠️ Never echo a password that came from the environment. This output is captured by
    // `docker compose run` and lands in the deployment log the operator pastes into a ticket.
    console.log(
      PASSWORD_FROM_ENV
        ? '    Password: (the SEED_PASSWORD you supplied — not echoed)'
        : `    Password: ${DEV_PASSWORD}   (same for every account below)`,
    );
    for (const u of USERS) {
      console.log(`    ${u.roles[0]?.padEnd(9)} ${u.email}`);
    }
    console.log(
      `\n  Seeded: 1 tenant · 1 org · ${USERS.length} users · 1 camera · 1 rule · 1 event · 1 incident · 1 alert`,
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
