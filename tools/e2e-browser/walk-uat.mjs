/**
 * **Walk `docs/project/CUSTOMER_ACCEPTANCE_CHECKLIST.md` step by step against the real product.**
 *
 *   node tools/e2e-browser/walk-uat.mjs
 *
 * ### ⛔ Why a script exists to test a document
 *
 * The acceptance checklist is handed to a customer-facing tester who has never seen this platform.
 * If one step says "click Investigations" and the sidebar says "Recorded Video", that tester cannot
 * tell a stale document from a broken product — and they will report the second. That is not
 * hypothetical: the first draft of the checklist did exactly this, and the reader was left logged in
 * with no idea which page to open.
 *
 * ⚠️ So every literal string the document promises — the page headings, the four headline numbers on
 * the assignment page, "This recording has not been analysed yet", "60 / 60", "yolox-nano", the
 * footage-time banner, "Nothing was detected in this recording" — is asserted here against the
 * deployed console. A wording change in the product now breaks this script rather than silently
 * making the document wrong.
 *
 * ⚠️ Kept as a script rather than a spec in `test/`: it verifies a **document**, not the product, and
 * running it alongside the certification suite would confuse two different failures. A red run here
 * means *the checklist is out of date*; a red run there means *the product is broken*.
 */
import { chromium } from '@playwright/test';
const V='/Users/mac/projects/VisionIntelligencePlatform/infra/docker/fixtures/media/validation';
let bad=0; const ok=(c,m)=>{console.log(`  ${c?'✓':'✗'} ${m}`); if(!c)bad++;};
const b=await chromium.launch();
const p=await (await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}})).newPage();

console.log('\n§0 platform ready');
await p.goto('https://localhost/');
await p.getByLabel(/tenant/i).fill('tnt_demo_retail');
await p.getByLabel(/email/i).fill('security.manager@northgate.demo');
await p.getByLabel(/password/i).fill('12345678');
await p.getByRole('button',{name:/sign in/i}).click();
await p.waitForTimeout(3000);
await p.goto('https://localhost/assignment'); await p.waitForTimeout(2500);
ok((await p.locator('h1').first().textContent())?.trim()==='Camera assignment','heading is "Camera assignment"');
const asn=await p.innerText('body');
for(const label of ['CAMERAS','AI ENABLED','CONFIRMED RUNNING','IN ERROR']) ok(asn.toUpperCase().includes(label),`headline "${label}" present`);
const num=(l)=>{const m=new RegExp(l+'\\s*\\n\\s*(\\d+)','i').exec(asn); return m?Number(m[1]):-1;};
ok(num('CONFIRMED RUNNING')>=1,`CONFIRMED RUNNING = ${num('CONFIRMED RUNNING')} (must be >= 1)`);
ok(num('IN ERROR')===0,`IN ERROR = ${num('IN ERROR')} (must be 0)`);

console.log('\n§2 upload page');
await p.goto('https://localhost/investigations'); await p.waitForTimeout(2000);
ok((await p.locator('h1').first().textContent())?.trim()==='Investigations','heading is "Investigations"');
ok((await p.innerText('body')).includes('MP4 only, up to 2 GB and 4 hours'),'limits stated before choosing a file');
ok(await p.getByRole('button',{name:/upload a recording/i}).isDisabled(),'upload disabled before a camera is chosen');
await p.getByLabel(/^camera$/i).click();
await p.getByRole('option',{name:/Main Entrance/i}).click();
ok(!(await p.getByRole('button',{name:/upload a recording/i}).isDisabled()),'upload enabled after choosing Main Entrance');

console.log('\n§3 run analysis on multiple-people.mp4');
const [created]=await Promise.all([
  p.waitForResponse(r=>r.url().endsWith('/api/media/analyses')&&r.request().method()==='POST',{timeout:120000}),
  p.locator('input[type=file]').setInputFiles(`${V}/multiple-people.mp4`)]);
const id=(await created.json()).data.analysis.id;
ok(true,`row created (${id})`);
await p.locator(`a[href="/investigations/${id}"]`).click(); await p.waitForTimeout(1500);
const before=await p.innerText('body');
ok(before.includes('This recording has not been analysed yet'),'"This recording has not been analysed yet" shown');
ok(await p.getByRole('button',{name:/run analysis/i}).count()>0,'"Run analysis" button present');
ok(await p.getByRole('button',{name:/demonstrate at real time/i}).count()>0,'"Demonstrate at real time" button present');
await p.getByRole('button',{name:/run analysis/i}).click();
await p.waitForSelector('text=/succeeded/i',{timeout:300000});
await p.waitForTimeout(1500);
const after=await p.innerText('body');
ok(/60\s*\/\s*60/.test(after),'FRAMES reads 60 / 60');
ok(after.includes('yolox-nano'),'MODEL reads yolox-nano');
ok(/real time/i.test(after),'a speed factor is shown');
ok(/upload time was used as the footage start/i.test(after),'footage-time banner present');

console.log('\n§4 timeline');
ok(after.includes('Timeline'),'Timeline section present');
ok(!/could not be looked up/i.test(after),'"could not be looked up" absent');
ok(await p.getByRole('button',{name:/capture still/i}).count()>0,'"Capture still" buttons present');

console.log('\n§6 evidence');
const [snap]=await Promise.all([
  p.waitForResponse(r=>r.url().includes('/snapshots')&&r.request().method()==='POST',{timeout:120000}),
  p.getByRole('button',{name:/capture still/i}).first().click()]);
ok(snap.status()===201,`snapshot returned HTTP ${snap.status()}`);
await p.waitForTimeout(2000);
ok(await p.locator('figure img').count()>0,'an image is rendered on the page');
ok(/into the recording/i.test(await p.innerText('body')),'caption says "… into the recording"');

console.log('\n§7 honesty test — empty-scene.mp4');
await p.goto('https://localhost/investigations'); await p.waitForTimeout(1500);
await p.getByLabel(/^camera$/i).click(); await p.getByRole('option',{name:/Main Entrance/i}).click();
const [c2]=await Promise.all([
  p.waitForResponse(r=>r.url().endsWith('/api/media/analyses')&&r.request().method()==='POST',{timeout:120000}),
  p.locator('input[type=file]').setInputFiles(`${V}/empty-scene.mp4`)]);
const id2=(await c2.json()).data.analysis.id;
await p.locator(`a[href="/investigations/${id2}"]`).click(); await p.waitForTimeout(1200);
await p.getByRole('button',{name:/run analysis/i}).click();
await p.waitForSelector('text=/succeeded/i',{timeout:300000});
await p.waitForTimeout(1500);
const empty=await p.innerText('body');
ok(/60\s*\/\s*60/.test(empty),'empty scene still analysed 60 / 60 frames');
ok(/nothing was detected/i.test(empty),'⭐ "Nothing was detected in this recording" shown');

console.log('\n§10 viewer cannot upload');
const vp=await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
await vp.goto('https://localhost/');
await vp.getByLabel(/tenant/i).fill('tnt_demo_retail');
await vp.getByLabel(/email/i).fill('loss.prevention@northgate.demo');
await vp.getByLabel(/password/i).fill('12345678');
await vp.getByRole('button',{name:/sign in/i}).click(); await vp.waitForTimeout(3000);
await vp.goto('https://localhost/investigations'); await vp.waitForTimeout(2500);
const up=vp.getByRole('button',{name:/upload a recording/i});
const n=await up.count();
ok(n===0||await up.isDisabled(),`viewer upload control ${n===0?'absent':(await up.isDisabled()?'disabled':'ENABLED — defect')}`);
await vp.close();

console.log(`\n${bad===0?'✓ every step in the acceptance document matches the product':`⛔ ${bad} step(s) do NOT match`}\n`);
await b.close();
process.exit(bad===0?0:1);
