/**
 * P-6.3 · does a tenant settings change survive a full stack restart?
 *
 *   node docs/review/p6/restart-persistence.mjs
 *
 * ⚠️ **Writes through the API, restarts every container, then reads back.** A test that restarts
 * only the tenant service would prove the service is stateless and nothing about whether the value
 * reached disk — the volume is what is under test, not the process.
 *
 * The script does not restart anything itself; it prints the value it wrote, waits for the operator
 * to restart the stack, and verifies afterwards. Run it with `--phase write` then `--phase verify`.
 */
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MARKER_FILE = process.env.MARKER ?? '/tmp/vip-p63-restart-marker.json';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'write';

async function api(method, path, { token, body, tenant } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${B}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

const token = (await api('POST', '/identity/auth/login', { body: ADMIN, tenant: TENANT })).json
  ?.data?.accessToken;
if (!token) {
  console.error('cannot sign in — is the stack up?');
  process.exit(1);
}

const fs = await import('node:fs/promises');

if (phase === 'write') {
  const before = (await api('GET', `/tenant/tenants/${TENANT}`, { token })).json.data;
  const marker = `Northgate Retail Group · restart probe ${Date.now()}`;
  const res = await api('PATCH', `/tenant/tenants/${TENANT}`, {
    token,
    body: { name: marker, expectedUpdatedAt: before.updatedAt },
  });
  if (res.status !== 200) {
    console.error('write failed', res.status, res.json);
    process.exit(1);
  }
  await fs.writeFile(
    MARKER_FILE,
    JSON.stringify({ marker, original: before.name, updatedAt: res.json.data.updatedAt }, null, 2),
  );
  console.log(`\n  wrote: ${marker}`);
  console.log(`  original name recorded for restore: ${before.name}`);
  console.log(`\n  Now restart the stack, then re-run with --phase verify.\n`);
  process.exit(0);
}

const saved = JSON.parse(await fs.readFile(MARKER_FILE, 'utf8'));
const after = (await api('GET', `/tenant/tenants/${TENANT}`, { token })).json.data;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('\nP-6.3 · persistence across a full stack restart\n');
check(
  after.name === saved.marker,
  'the tenant name written before the restart survived',
  after.name,
);
check(
  after.updatedAt === saved.updatedAt,
  '⚠️ …and so did `updatedAt` — the concurrency token is durable, not in-memory',
  after.updatedAt,
);
check(after.slug === 'northgate', 'the slug is unchanged', after.slug);
check(after.status === 'active', 'the status is unchanged', after.status);

/*
 * ⚠️ Branding is served from the console image, so a restart is exactly when it would go missing:
 * a file bind-mounted over the image's copy is the documented white-label mechanism, and a restart
 * that silently reverted to the built-in defaults would be invisible until a customer noticed.
 */
const brandingRes = await fetch(`${B}/branding.json`);
check(
  brandingRes.ok,
  'branding.json is still served after the restart',
  `HTTP ${brandingRes.status}`,
);

// Restore.
const current = (await api('GET', `/tenant/tenants/${TENANT}`, { token })).json.data;
const restored = await api('PATCH', `/tenant/tenants/${TENANT}`, {
  token,
  body: { name: saved.original, expectedUpdatedAt: current.updatedAt },
});
check(
  restored.status === 200 && restored.json.data.name === saved.original,
  '⚠️ dataset restored',
  saved.original,
);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
