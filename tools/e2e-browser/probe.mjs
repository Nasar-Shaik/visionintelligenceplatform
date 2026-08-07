import { chromium } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto('https://localhost/');
await p.getByLabel(/tenant/i).fill('tnt_demo_retail');
await p.getByLabel(/email/i).fill('security.manager@northgate.demo');
await p.getByLabel(/password/i).fill('12345678');
await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForTimeout(3000);
await p.goto('https://localhost/investigations');
await p.waitForTimeout(2500);
console.log('--- INVESTIGATIONS headings ---');
for (const h of await p.locator('h1,h2,h3').all()) console.log(' ', await h.evaluate(e=>e.tagName), JSON.stringify((await h.textContent())?.trim()));
const links = await p.getByRole('link').all();
console.log('--- first 12 links ---');
for (const l of links.slice(0,12)) console.log('  ', JSON.stringify((await l.textContent())?.trim()), await l.getAttribute('href'));
// open the first investigation row link
const rowLinks = links.filter(async l => (await l.getAttribute('href'))?.startsWith('/investigations/'));
const target = await p.locator('a[href^="/investigations/"]').first();
if (await target.count()) {
  console.log('--- opening', await target.getAttribute('href'));
  await target.click();
  await p.waitForTimeout(3000);
  console.log('--- DETAIL headings ---');
  for (const h of await p.locator('h1,h2,h3').all()) console.log(' ', await h.evaluate(e=>e.tagName), JSON.stringify((await h.textContent())?.trim()));
  console.log('--- DETAIL buttons ---');
  for (const btn of await p.getByRole('button').all()) console.log('  ', JSON.stringify((await btn.textContent())?.trim()));
  console.log('--- DETAIL body (600) ---');
  console.log((await p.innerText('body')).slice(0,600).replace(/\n/g,' | '));
}
await b.close();
