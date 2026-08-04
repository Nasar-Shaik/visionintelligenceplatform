import { chromium } from 'playwright';
const B = 'https://localhost';
const b = await chromium.launch();
const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const p = await c.newPage();

const log = [];
p.on('console', (m) => {
  if (m.type() === 'error') log.push('[console] ' + m.text().slice(0, 200));
});
p.on('pageerror', (e) => log.push('[pageerror] ' + e.message));
const reqs = [];
p.on('request', (r) => {
  if (r.url().includes('/api/rules/')) reqs.push(`→ ${r.method()} ${r.url().replace(B, '')}`);
});
p.on('response', async (r) => {
  if (r.url().includes('/api/rules/') && r.request().method() !== 'GET')
    reqs.push(
      `← ${r.status()} ${r.url().replace(B, '')} ${(await r.text().catch(() => '')).slice(0, 200)}`,
    );
});

await p.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await p.getByLabel(/tenant/i).fill('tnt_demo_retail');
await p.getByLabel(/email/i).fill('security.manager@northgate.demo');
await p.getByLabel(/password/i).fill('Vip-Demo-2026!');
await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForURL((u) => !u.pathname.startsWith('/login'));

// Open an existing rule for editing.
await p.goto(`${B}/rules/rule_demo_retail_afterhours`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const nameBox = p.getByLabel(/^name/i).first();
console.log('name field value:', await nameBox.inputValue().catch((e) => 'ERR ' + e.message));

// Change the name only — the minimal edit.
await nameBox.fill('After-hours presence — stock room (edited)');

const save = p.getByRole('button', { name: /save|update|apply/i }).first();
console.log('save button:', await save.textContent().catch(() => 'NOT FOUND'));
await save.click();
await p.waitForTimeout(3000);

// Any inline validation messages now on screen?
const errs = await p.evaluate(() =>
  [...document.querySelectorAll('[role="alert"], .text-critical, [data-error], p')]
    .map((e) => e.textContent?.trim() ?? '')
    .filter((t) => /invalid|required|expected|error/i.test(t))
    .slice(0, 8),
);

console.log('\n── network ──');
console.log(reqs.join('\n') || '(no rules mutation request fired)');
console.log('\n── validation messages ──');
console.log(errs.join('\n') || '(none)');
console.log('\n── console ──');
console.log(log.join('\n') || '(clean)');
await p.screenshot({ path: process.env.OUT + '/td21-repro.png' });
await b.close();
