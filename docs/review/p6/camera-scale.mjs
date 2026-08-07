/**
 * P-6.6 · **the camera estate at 100, 500, 1 000 and 5 000 — measured, not predicted.**
 *
 *   node docs/review/p6/camera-scale.mjs            # load, measure at each size, clean
 *   node docs/review/p6/camera-scale.mjs clean      # ⚠️ if a run was interrupted
 *
 * The question this answers is not "is it fast" but **"where does it stop being a list and start
 * being a problem"** — and whether the answer justifies work nobody has done yet (virtualization,
 * caching, an index). ⚠️ Optimising before this measurement would be optimising a guess.
 *
 * What is measured at each size:
 *   · the list query an operator's first screen issues (a page of 50)
 *   · a search — the regex scan across seven fields, which is the linear read here
 *   · the estate count the page's "of N" comes from
 *   · the payload the browser is handed
 *
 * ⚠️ Rows are marked `scaleTest: true` and removed afterwards; the delta against the estate found at
 * the start is asserted, because "it cleaned up" is a claim like any other.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const MONGO = 'vip-prod-mongodb-1';
const SIZES = [100, 500, 1_000, 5_000];

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

function mongo(js) {
  return execFileSync(
    'docker',
    [
      'exec', '-i', MONGO, 'mongosh', '--quiet',
      '-u', env.MONGO_USER, '-p', env.MONGO_PASSWORD,
      '--authenticationDatabase', 'admin', 'vip', '--eval', js,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function api(path, token) {
  const started = performance.now();
  const res = await fetch(`${B}/api${path}`, {
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - started, bytes: text.length, json: JSON.parse(text) };
}

const clean = () => {
  const out = mongo(
    `print(JSON.stringify({removed: db.cameras.deleteMany({scaleTest:true}).deletedCount, total: db.cameras.countDocuments({})}))`,
  );
  return JSON.parse(out.split('\n').pop());
};

/** Insert up to `target` marked cameras, so each size builds on the last rather than re-seeding. */
function growTo(target) {
  const script = `
    const T = ${JSON.stringify(TENANT)};
    const have = db.cameras.countDocuments({scaleTest:true});
    const need = ${target} - have;
    if (need > 0) {
      const makers = ['Hikvision','Dahua','Axis','Uniview','CP Plus'];
      const docs = [];
      for (let i = have; i < ${target}; i += 1) {
        const iso = new Date(Date.now() - i * 60000).toISOString();
        docs.push({
          _id: 'cam_scale_' + String(i).padStart(6,'0'),
          tenantId: T, zoneId: 'on_retail_store_01',
          name: 'Scale camera ' + i,
          protocol: 'rtsp',
          streamUrl: 'rtsp://10.20.' + Math.floor(i/254) + '.' + (i%254) + ':554/Streaming/Channels/101',
          status: 'enabled',
          capture: { ptz: false, codec: 'h264', resolution: '1920x1080', fps: 12 },
          health: { status: i % 7 === 0 ? 'offline' : 'online', lastCheckedAt: iso },
          capabilities: { ptz: i%3===0, audio: i%5===0, snapshot: true, codecs: ['h264'],
            resolutions: ['1920x1080','640x360'], protocols: ['rtsp'], streamProfiles: [],
            onvif: i%2===0, metadataStream: false },
          metadata: { manufacturer: makers[i % makers.length], model: 'DS-' + (2000+i%900),
            tags: i%4===0 ? ['entrance'] : [], serialNumber: 'SN' + i },
          lifecycle: { state: i % 11 === 0 ? 'retired' : 'monitoring', since: iso, evidence: 'declared' },
          timeline: [], identityHistory: [], compatibility: [], probeCount: 0,
          hasCredentials: false, credentialCipher: null,
          createdAt: iso, updatedAt: iso,
          scaleTest: true,
        });
        if (docs.length >= 1000) { db.cameras.insertMany(docs, {ordered:false}); docs.length = 0; }
      }
      if (docs.length) db.cameras.insertMany(docs, {ordered:false});
    }
    print(JSON.stringify({marked: db.cameras.countDocuments({scaleTest:true}), total: db.cameras.countDocuments({})}));
  `;
  return JSON.parse(mongo(script).split('\n').pop());
}


/* ⚠️ `load` exists so the **browser** can be measured at scale too — the server being flat says
   nothing about a screen that renders every row it is given. */
if (process.argv[2] === 'load') {
  const target = Number(process.argv[3] ?? 5000);
  const before = Number(mongo('db.cameras.countDocuments({})'));
  const grown = growTo(target);
  console.log(`\nestate ${before} → ${grown.total} (${grown.marked} marked)\n⚠️  remember: node docs/review/p6/camera-scale.mjs clean\n`);
  process.exit(0);
}

if (process.argv[2] === 'clean') {
  const r = clean();
  console.log(`\nremoved ${r.removed} scale rows · ${r.total} cameras remain\n`);
  process.exit(0);
}

console.log('\nP-6.6 · the camera estate at scale\n');

const auth = await fetch(`${B}/api/identity/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
  body: JSON.stringify(ADMIN),
}).then((r) => r.json());
const token = auth.data.accessToken;

const baseline = Number(mongo('db.cameras.countDocuments({})'));
console.log(`  estate before: ${baseline} cameras\n`);

const rows = [];
for (const size of SIZES) {
  const grown = growTo(size);
  const total = grown.total;

  const timed = async (path, n = 12) => {
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < n; i += 1) {
      const r = await api(path, token);
      samples.push(r.ms);
      bytes = r.bytes;
    }
    samples.sort((a, b) => a - b);
    return { p50: samples[Math.floor(n / 2)], p95: samples[Math.floor(n * 0.95)], bytes };
  };

  const list = await timed('/camera/cameras?limit=50');
  const search = await timed('/camera/cameras?limit=50&search=Dahua');
  const count = await timed('/camera/cameras/metrics?window=day', 6);
  const deep = await (async () => {
    /* Page ten deep, which is where the console's bound sits. */
    let cursor;
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = await api(
        `/camera/cameras?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        token,
      );
      cursor = r.json.data.nextCursor;
      last = r.ms;
      if (!cursor) break;
    }
    return last;
  })();

  rows.push({ size: total, list, search, count, deep });
  console.log(
    `  ${String(total).padStart(5)} cameras · page ${list.p50.toFixed(0)}/${list.p95.toFixed(0)} ms` +
      ` · search ${search.p50.toFixed(0)}/${search.p95.toFixed(0)} ms` +
      ` · count ${count.p50.toFixed(0)} ms · page 10 ${deep.toFixed(0)} ms` +
      ` · payload ${(list.bytes / 1024).toFixed(0)} KB`,
  );
}

console.log('');
const biggest = rows[rows.length - 1];
const smallest = rows[0];

check(
  biggest.list.p95 < 250,
  '⚠️ the first screen still answers within a beat at 5 000 cameras',
  `${biggest.list.p95.toFixed(0)} ms p95`,
);
check(
  biggest.deep < 400,
  '⚠️ page ten costs what page one costs — keyset paging, not skip/limit',
  `${biggest.deep.toFixed(0)} ms`,
);
check(
  biggest.list.bytes < 200_000,
  'a page of fifty is a sane payload however big the estate is',
  `${(biggest.list.bytes / 1024).toFixed(0)} KB`,
);
/*
 * ⚠️ The honest number. Search is a case-insensitive regex over seven fields — a **linear** read of
 * the tenant's cameras, by design, because an installer types a fragment of a URL and expects a
 * substring match. This records where that starts to matter rather than claiming it never will.
 */
const searchGrowth = biggest.search.p95 / Math.max(1, smallest.search.p95);
console.log(
  `  · search cost from ${smallest.size} → ${biggest.size} cameras: ×${searchGrowth.toFixed(1)}` +
    ` (${smallest.search.p95.toFixed(0)} → ${biggest.search.p95.toFixed(0)} ms p95)`,
);
check(
  biggest.search.p95 < 500,
  '⚠️ and the substring search is still usable at 5 000 — recorded as linear, not claimed as indexed',
  `${biggest.search.p95.toFixed(0)} ms p95`,
);

const after = clean();
check(
  after.total === baseline,
  '⚠️ the harness left nothing behind',
  `${baseline} → ${after.total} (removed ${after.removed})`,
);

console.log(`\n${failures === 0 ? '✓ camera scale: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
