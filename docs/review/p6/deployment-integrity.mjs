/**
 * P-6.5 freeze · **is the thing being verified the thing that was committed?**
 *
 *   pnpm build && node docs/review/p6/deployment-integrity.mjs
 *
 * Every other script in this folder measures the deployment. This one measures whether the
 * deployment is the *commit* — because a green verification of a stale image is worth nothing, and
 * it looks exactly like a green verification.
 *
 * ### ⚠️ Why this exists
 *
 * The P-6.5 close-out found the demo dataset being restored with `attempts: 3` and "…after 3
 * attempts" — the fabricated retry count the milestone had removed, and which the platform has never
 * had. The source was correct and committed. The image that runs the seeder (`vip/identity:local`,
 * which carries `tools/seed`) had been built **before** the fix and never rebuilt, so the one command
 * a salesperson runs before a demonstration put the fabrication back. Nothing was wrong with the
 * code, the tests, or the verification scripts. The wrong bytes were running.
 *
 * What is compared, per container:
 *   · the compiled `dist` of every service and package, file by file, against a build of the
 *     working tree — tsc output is deterministic, so equal bytes mean equal source
 *   · the console bundle in the image **and** the one the edge actually serves
 *   · the image the container is running against the current tag (a rebuilt image nobody recreated
 *     the container for is the same defect one step later)
 *   · the working tree is clean, and the commit hash is recorded in the output
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Every service in the production compose file, with the container that runs it. */
const SERVICES = [
  'identity',
  'tenant',
  'camera',
  'media',
  'events',
  'rules',
  'workflow',
  'notify',
  'evidence',
  'gateway',
];

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

function localFiles(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.set(next, md5(readFileSync(join(dir, next))));
    }
  };
  try {
    if (statSync(dir).isDirectory()) walk('');
  } catch {
    return null;
  }
  return out;
}

/** `md5sum` over the same tree inside the container, as `path → hash`. */
function containerFiles(container, dir) {
  let raw;
  try {
    raw = sh('docker', [
      'exec',
      container,
      'sh',
      '-c',
      `cd ${dir} 2>/dev/null && find . -type f | sort | xargs -r md5sum`,
    ]);
  } catch {
    return null;
  }
  const out = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^([0-9a-f]{32})\s+\.\/(.+)$/);
    if (m) out.set(m[2], m[1]);
  }
  return out.size > 0 ? out : null;
}

/**
 * ⚠️ **Runtime bytes are compared strictly; type declarations are reported, not judged.**
 *
 * The first version of this failed `camera` and `contracts` and was right to be looked at — and
 * wrong. Every difference was in a `.d.ts`, and every one was a union printed in a different order
 * (`"disabled" | "enabled"` against `"enabled" | "disabled"`). TypeScript does not guarantee a
 * stable order in declaration emit across compilations, so `.d.ts` output is **not** byte
 * reproducible, while the `.js` it emits alongside is. A declaration file never executes: it cannot
 * change what the deployment does. Holding it to a byte comparison would produce a red that can
 * only be silenced by ignoring it, which is how a gate stops being read.
 */
const isRuntime = (path) => !path.endsWith('.d.ts') && !path.endsWith('.map');

function compare(label, local, deployed, where = '') {
  if (local === null) return check(false, `${label} — nothing built locally to compare against`);
  if (deployed === null) return check(false, `${label} — nothing deployed to compare`);
  const differing = [];
  const declarations = [];
  for (const [path, hash] of local) {
    const there = deployed.get(path);
    const note = there === undefined ? `${path} (missing in the image)` : path;
    if (there === hash) continue;
    (isRuntime(path) ? differing : declarations).push(note);
  }
  for (const path of deployed.keys())
    if (!local.has(path)) (isRuntime(path) ? differing : declarations).push(`${path} (only in the image)`);
  const runtime = [...local.keys()].filter(isRuntime).length;
  check(
    differing.length === 0,
    `${label} — every byte that executes is the byte that was built${where}`,
    differing.length === 0
      ? `${runtime} runtime files identical${declarations.length > 0 ? ` (${declarations.length} .d.ts differ in union order — they do not execute)` : ''}`
      : `${differing.length} differ: ${differing.slice(0, 3).join(', ')}`,
  );
  return differing;
}

console.log('\nP-6.5 freeze · deployment integrity\n');

// ── 0 · what is committed ───────────────────────────────────────────────────────────────────────
const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
const short = commit.slice(0, 8);
const dirty = sh('git', ['-C', ROOT, 'status', '--porcelain']).trim();
console.log(`0 · commit under verification: ${short}`);
console.log(`      ${sh('git', ['-C', ROOT, 'log', '-1', '--format=%s']).trim()}`);
check(
  dirty === '',
  '0a · ⚠️ the working tree is clean — what is deployed can be named by a commit hash',
  dirty === '' ? short : `${dirty.split('\n').length} uncommitted file(s)`,
);

// ── 1 · every service image carries the committed build ─────────────────────────────────────────
console.log('\n1 · services');
for (const svc of SERVICES) {
  const container = `vip-prod-${svc}-1`;
  compare(
    `1·${svc}`,
    localFiles(join(ROOT, 'services', svc, 'dist')),
    containerFiles(container, `/app/services/${svc}/dist`),
  );
}

/*
 * ── 2 · the shared packages ─────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Looked for in **whichever image actually carries them**. Comparing every package inside the
 * gateway reported `crypto`, `storage` and `tenancy` as "nothing deployed to compare" — three reds
 * for packages the gateway image legitimately does not contain, because the build prunes each
 * service to its own dependency closure. A check that goes red for a correct deployment gets
 * explained away, and the next red gets explained away with it.
 */
console.log('\n2 · shared packages, in the images that carry them');
const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
for (const pkg of packages) {
  const local = localFiles(join(ROOT, 'packages', pkg, 'dist'));
  if (local === null) continue; // not every package compiles to dist
  let found = null;
  for (const svc of SERVICES) {
    const deployed = containerFiles(`vip-prod-${svc}-1`, `/app/packages/${pkg}/dist`);
    if (deployed !== null) {
      found = { svc, deployed };
      break;
    }
  }
  if (found === null) {
    check(false, `2·${pkg} — no running image carries this package`);
    continue;
  }
  compare(`2·${pkg}`, local, found.deployed, ` (in ${found.svc})`);
}

// ── 3 · the console bundle, in the image and at the edge ────────────────────────────────────────
console.log('\n3 · console');
compare(
  '3a·console',
  localFiles(join(ROOT, 'apps', 'console', 'dist')),
  containerFiles('vip-prod-console-1', '/srv'),
);

/*
 * ⚠️ And the bundle the **browser** is given, which is the only one a screenshot can be of. Vite
 * hashes chunk contents into their filenames, so the name the served index.html points at is a
 * content address: if it names the file the working tree builds, the running app is that source.
 */
const html = await fetch(`${B}/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
const served = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
const built = new Set(readdirSync(join(ROOT, 'apps', 'console', 'dist', 'assets')));
const strays = served.filter((f) => !built.has(f));
console.log(`  · the edge serves: ${served.join(', ')}`);
check(
  served.length > 0 && strays.length === 0,
  '3b · ⚠️ the bundle the browser is handed is the one this tree builds',
  strays.length === 0 ? `${served.length} content-hashed chunks match` : `stray: ${strays.join(', ')}`,
);

// ── 4 · no container is running a superseded image ──────────────────────────────────────────────
console.log('\n4 · containers');
for (const svc of [...SERVICES, 'console']) {
  const container = `vip-prod-${svc}-1`;
  let running;
  let tag;
  try {
    running = sh('docker', ['inspect', container, '--format', '{{.Image}}']).trim();
    const image = sh('docker', ['inspect', container, '--format', '{{.Config.Image}}']).trim();
    tag = sh('docker', ['image', 'inspect', image, '--format', '{{.Id}}']).trim();
  } catch {
    check(false, `4·${svc} — container is not running`);
    continue;
  }
  check(
    running === tag,
    `4·${svc} — the container runs the current image, not one it was started with`,
    running === tag ? running.slice(7, 19) : `container ${running.slice(7, 19)} ≠ tag ${tag.slice(7, 19)}`,
  );
}

/*
 * ⚠️ The seeder is not a service and has no container of its own — it runs from `vip/identity:local`
 * on demand (`infra/docker/demo.sh reset`). That is exactly why its staleness went unnoticed: nothing
 * restarts it, nothing health-checks it, and it is only ever run right before somebody demonstrates
 * the product.
 */
console.log('\n5 · the demo seeder (runs from vip/identity:local — no container of its own)');
const seedInImage = sh('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  'vip/identity:local',
  '-c',
  'md5sum /app/tools/seed/demo.ts',
]).slice(0, 32);
const seedLocal = md5(readFileSync(join(ROOT, 'tools', 'seed', 'demo.ts')));
check(
  seedInImage === seedLocal,
  '5a · ⚠️ the image that reseeds a demonstration carries the committed seed',
  seedInImage === seedLocal ? seedLocal.slice(0, 12) : `image ${seedInImage.slice(0, 12)} ≠ tree ${seedLocal.slice(0, 12)}`,
);

console.log(
  `\n${failures === 0 ? `✓ deployment integrity: every running byte is commit ${short}` : `✗ ${failures} check(s) failed — the deployment is not ${short}`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
