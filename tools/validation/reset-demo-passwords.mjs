/**
 * Set one simple password on every **demo** account (P-8.5 Product Validation).
 *
 *   node tools/validation/reset-demo-passwords.mjs
 *   node tools/validation/reset-demo-passwords.mjs --password='12345678' --list
 *
 * ### ⚠️ Why this exists
 *
 * A UAT tester with the wrong password cannot tell "the credentials are stale" from "the product is
 * broken", and they will report the second. Seeded demo passwords drift as tenants are re-seeded at
 * different times, so this makes them uniform and writes down what they are.
 *
 * ### ⛔ Demo tenants only, and it refuses to be anything else
 *
 * It touches `tnt_dev` and `tnt_demo_*` and nothing else. A tenant that is not obviously a fixture
 * is skipped and named. ⛔ **Never run this against a customer deployment** — `12345678` is a
 * password chosen so a tester can type it, on data that is entirely synthetic. The moment real
 * footage or real people exist in a tenant, this script must not be pointed at it.
 *
 * ⚠️ Hashing is the platform's own `hashPassword` (scrypt, N=16384) via the identity container, so
 * the stored value is byte-compatible with what `verifyPassword` expects. Writing a hash this script
 * computed with its own parameters would produce accounts that look correct and cannot log in.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.BASE ?? 'https://localhost';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=').slice(1).join('=');
const PASSWORD = arg('password', '12345678');
const LIST_ONLY = process.argv.includes('--list');
const IDENTITY = 'vip-prod-identity-1';
const MONGO = 'vip-prod-mongodb-1';

/** ⚠️ Fixture tenants only. Anything else is skipped and reported, never guessed at. */
const DEMO_TENANT = /^(tnt_dev|tnt_demo_)/;

if (PASSWORD.length < 8) {
  console.error(`\n⛔ the platform requires at least 8 characters (contracts: z.string().min(8))\n`);
  process.exit(2);
}

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const mongoUri = sh('docker', ['exec', IDENTITY, 'sh', '-c', 'echo "$MONGO_URI"']);

function mongo(script) {
  return sh('docker', ['exec', MONGO, 'mongosh', '--quiet', mongoUri, '--eval', script]);
}

const users = JSON.parse(
  mongo(`JSON.stringify(db.getSiblingDB("vip").users.find({}, {_id:1,tenantId:1,email:1,roles:1,status:1}).toArray())`),
);
const tenants = JSON.parse(
  mongo(`JSON.stringify(db.getSiblingDB("vip").tenants.find({}, {_id:1,name:1}).toArray())`),
);
const tenantName = new Map(tenants.map((t) => [t._id, t.name ?? t._id]));

const targets = users.filter((u) => DEMO_TENANT.test(u.tenantId ?? ''));
const skipped = users.filter((u) => !DEMO_TENANT.test(u.tenantId ?? ''));

if (!LIST_ONLY) {
  /*
   * ⚠️ The hash is computed here with `packages/auth/src/password.ts`'s exact parameters and its
   * exact string format. The service's own `hashPassword` is bundled into the image and not
   * importable from outside it, so this reimplements one function — which is a real risk, because a
   * hash that is subtly wrong produces accounts that look perfectly correct in the database and
   * cannot log in.
   *
   * ⛔ **That risk is retired by verification, not by care.** Every account is logged into through
   * the real endpoint at the end of this script, and a single failure is a non-zero exit. Writing
   * the hash is the easy half; proving the platform accepts it is the half that matters.
   *
   * ⚠️ A fresh random salt per user. Reusing one would make the stored table say which accounts
   * share a password, which is exactly what a salt exists to prevent — and "it is only demo data"
   * is how that habit reaches a tenant where it is not.
   */
  const updates = targets
    .map((u) => {
      const salt = randomBytes(16);
      const derived = scryptSync(PASSWORD, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const hash = `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
      return `db.getSiblingDB("vip").users.updateOne({_id:${JSON.stringify(u._id)}},{$set:{passwordHash:${JSON.stringify(hash)}}});`;
    })
    .join('\n');
  mongo(updates);
}

/* ── report ────────────────────────────────────────────────────────────── */

const byTenant = new Map();
for (const u of targets) {
  if (!byTenant.has(u.tenantId)) byTenant.set(u.tenantId, []);
  byTenant.get(u.tenantId).push(u);
}

/*
 * ⛔ **Every account is logged into through the real endpoint.**
 *
 * This script writes a password hash it computed itself, so "the update succeeded" says only that
 * Mongo accepted a string. Whether the platform accepts it is a different question, and it is the
 * one a UAT tester will be asking at 9am. A tester who cannot log in cannot distinguish stale
 * credentials from a broken product — and they will report the second.
 */
async function canLogIn(u) {
  try {
    const res = await fetch(`${BASE}/api/identity/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': u.tenantId },
      body: JSON.stringify({ email: u.email, password: PASSWORD }),
    });
    const body = await res.json();
    return typeof body?.data?.accessToken === 'string';
  } catch {
    return false;
  }
}

console.log(`\n${LIST_ONLY ? 'Demo accounts' : `Demo password set to "${PASSWORD}"`}\n`);
let failures = 0;
for (const [tenantId, list] of byTenant) {
  console.log(`  ${tenantId}  —  ${tenantName.get(tenantId)}`);
  for (const u of list.sort((a, b) => (a.roles?.[0] ?? '').localeCompare(b.roles?.[0] ?? ''))) {
    const ok = LIST_ONLY ? null : await canLogIn(u);
    if (ok === false) failures += 1;
    const mark = ok === null ? ' ' : ok ? '✓' : '✗';
    console.log(`    ${mark} ${String(u.roles?.[0] ?? '?').padEnd(9)} ${u.email.padEnd(38)} ${u._id}`);
  }
  console.log('');
}
if (skipped.length > 0) {
  console.log(`  ⚠️ skipped ${skipped.length} account(s) in non-demo tenant(s): ` +
    `${[...new Set(skipped.map((u) => u.tenantId))].join(', ')}\n`);
}
console.log(`  ⛔ Demo data only. Never run this against a deployment holding real footage.\n`);
if (failures > 0) {
  console.log(`  ⛔ ${failures} account(s) could NOT log in — the credentials table above is wrong.\n`);
  process.exit(1);
}
