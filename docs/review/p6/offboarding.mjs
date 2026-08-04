/**
 * P-6.2 · TD-44 — offboarding, verified against the production deployment.
 *
 * ⚠️ This walks the **API through the gateway**, not the service directly, because the gateway is
 * where the access token is verified and the tenant context is minted. A test against
 * `identity:8089` would prove the route works and prove nothing about whether a customer can reach
 * it. Run from /private/tmp/pwrun (Playwright is not a repo dependency).
 *
 *   node docs/review/p6/offboarding.mjs
 *
 * What it asserts, in order:
 *   1. a disposable user is created and can sign in
 *   2. their session is live (refresh works)
 *   3. an admin disables them — and the response says how many sessions that ended
 *   4. ⚠️ their refresh token is dead **immediately**
 *   5. ⚠️ they cannot sign in again
 *   6. an operator is refused the disable route (403) — the permission gate, at the edge
 *   7. re-enable restores sign-in but NOT the revoked token
 *   8. a password reset ends sessions and the old password stops working
 *   9. a cross-tenant disable is a 404, not a 403 (no enumeration oracle)
 *  10. the disposable user is removed, leaving the demo dataset pristine
 */
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const OPERATOR = { email: 'day.operator@northgate.demo', password: 'Vip-Demo-2026!' };
/*
 * ⚠️ A fresh address per run. The first version used a fixed one and the second run failed with a
 * 409 on every check — there is deliberately no DELETE route for a user, so a probe that reuses an
 * address can only be run once. Cleanup is the mongosh line printed at the end.
 */
const VICTIM = {
  email: `p62.offboarding.probe.${Date.now()}@northgate.demo`,
  password: 'Probe-Password-2026!',
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed edge certificate

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

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
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const login = (creds) => api('POST', '/identity/auth/login', { body: creds, tenant: TENANT });

console.log('\nP-6.2 · offboarding against the deployment\n');

// ── setup ───────────────────────────────────────────────────────────────────────────────────────
const admin = await login(ADMIN);
if (admin.status !== 200) {
  console.error('cannot sign in as the demo administrator', admin.status, admin.json);
  process.exit(1);
}
const adminTok = admin.json.data.accessToken;

const created = await api('POST', '/identity/users', {
  token: adminTok,
  body: { email: VICTIM.email, password: VICTIM.password, roles: ['operator'] },
});
check(created.status === 201, '1 · a disposable user is created', `HTTP ${created.status}`);
const victimId = created.json?.data?.id;

const session = await login(VICTIM);
check(session.status === 200, '1 · the new user can sign in', `HTTP ${session.status}`);
const victimRefresh = session.json?.data?.refreshToken;

// A second session, so the revoked count is unambiguous rather than "at least one".
const second = await login(VICTIM);
const rotated = await api('POST', '/identity/auth/refresh', {
  body: { refreshToken: second.json?.data?.refreshToken },
});
check(
  rotated.status === 200,
  '2 · the session is live (refresh rotates)',
  `HTTP ${rotated.status}`,
);

// ── the act ─────────────────────────────────────────────────────────────────────────────────────
const disabled = await api('POST', `/identity/users/${victimId}/disable`, { token: adminTok });
check(disabled.status === 200, '3 · an admin disables the account', `HTTP ${disabled.status}`);
check(
  disabled.json?.data?.user?.status === 'disabled',
  '3 · the account reads as disabled',
  String(disabled.json?.data?.user?.status),
);
/*
 * ⚠️ Exactly 2, and the exactness is the point. One of the two sessions was rotated before this
 * ran, which leaves three token *records* in two families. Counting records reported 3 — a
 * security action reporting a number larger than the number of devices. `=== 2` is what makes the
 * regression visible; `>= 1` would have shipped the wrong number.
 */
check(
  disabled.json?.data?.sessionsRevoked === 2,
  '3 · both live sessions were revoked (2 sessions, 3 token records)',
  `sessionsRevoked=${disabled.json?.data?.sessionsRevoked}`,
);

const deadRefresh = await api('POST', '/identity/auth/refresh', {
  body: { refreshToken: victimRefresh },
});
check(
  deadRefresh.status === 401,
  '4 · the open session is dead immediately',
  `HTTP ${deadRefresh.status}`,
);

const deniedLogin = await login(VICTIM);
check(deniedLogin.status === 401, '5 · they cannot sign in again', `HTTP ${deniedLogin.status}`);

// ── the permission gate, at the edge ────────────────────────────────────────────────────────────
const operator = await login(OPERATOR);
const opTok = operator.json?.data?.accessToken;
const opAttempt = await api('POST', `/identity/users/${victimId}/enable`, { token: opTok });
check(opAttempt.status === 403, '6 · an operator is refused (403)', `HTTP ${opAttempt.status}`);
const opRead = await api('GET', `/identity/users/${victimId}`, { token: opTok });
check(
  opRead.status === 200,
  '6 · …but may still read the user (`*:read`)',
  `HTTP ${opRead.status}`,
);

// ── restore ─────────────────────────────────────────────────────────────────────────────────────
const enabled = await api('POST', `/identity/users/${victimId}/enable`, { token: adminTok });
check(enabled.status === 200, '7 · re-enable succeeds', `HTTP ${enabled.status}`);
const backIn = await login(VICTIM);
check(backIn.status === 200, '7 · they can sign in again', `HTTP ${backIn.status}`);
const stillDead = await api('POST', '/identity/auth/refresh', {
  body: { refreshToken: victimRefresh },
});
check(stillDead.status === 401, '7 · the revoked token stays revoked', `HTTP ${stillDead.status}`);

// ── password reset ──────────────────────────────────────────────────────────────────────────────
const reset = await api('POST', `/identity/users/${victimId}/password`, {
  token: adminTok,
  body: { password: 'A-Completely-New-Secret-2026' },
});
check(reset.status === 200, '8 · an admin sets a new password', `HTTP ${reset.status}`);
check(
  reset.json?.data?.sessionsRevoked === 1,
  '8 · the reset ended the live session',
  `sessionsRevoked=${reset.json?.data?.sessionsRevoked}`,
);
const oldPassword = await login(VICTIM);
check(
  oldPassword.status === 401,
  '8 · the old password stops working',
  `HTTP ${oldPassword.status}`,
);
const newPassword = await login({ email: VICTIM.email, password: 'A-Completely-New-Secret-2026' });
check(newPassword.status === 200, '8 · the new password works', `HTTP ${newPassword.status}`);

// ── isolation ───────────────────────────────────────────────────────────────────────────────────
const otherTenant = await api('POST', '/identity/auth/login', {
  body: { email: 'site.manager@meridian.demo', password: 'Vip-Demo-2026!' },
  tenant: 'tnt_demo_warehouse',
});
if (otherTenant.status === 200) {
  const cross = await api('POST', `/identity/users/${victimId}/disable`, {
    token: otherTenant.json.data.accessToken,
  });
  check(
    cross.status === 404,
    '9 · a cross-tenant disable is 404, not 403 (no enumeration oracle)',
    `HTTP ${cross.status}`,
  );
} else {
  check(
    false,
    '9 · could not sign in to the second tenant to test isolation',
    `HTTP ${otherTenant.status}`,
  );
}

// ── self-disable ────────────────────────────────────────────────────────────────────────────────
const me = await api('GET', '/identity/auth/me', { token: adminTok });
const selfDisable = await api('POST', `/identity/users/${me.json?.data?.principalId}/disable`, {
  token: adminTok,
});
check(
  selfDisable.status === 400,
  '9b · an admin cannot disable themselves',
  `HTTP ${selfDisable.status}`,
);

// ── leave the dataset pristine ──────────────────────────────────────────────────────────────────
console.log(`
⚠️  This probe created a user and there is no DELETE route. Restore the demo dataset with:

  docker exec vip-prod-mongodb-1 mongosh -u "$MONGO_USER" -p "$MONGO_PASSWORD" \\
    --authenticationDatabase admin vip --quiet \\
    --eval 'db.users.deleteMany({ email: /^p62\\.offboarding\\.probe/ })'

  (⚠️ the database is \`vip\`, not \`vip_identity\` — every service shares one database.)
`);
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
