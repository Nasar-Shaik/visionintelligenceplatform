/**
 * Frontend performance budget (P-5.3, mid-milestone requirement 4).
 *
 * ### ⚠️ Why a byte budget is a threshold when a timing budget is not
 *
 * CONSTRAINTS §51 forbids turning a recorded number into a gate: a benchmark is a comparison point
 * on the machine that produced it, and a loaded CI runner moves milliseconds. **Bytes are not
 * milliseconds.** A bundle's size is deterministic — the same source and the same lockfile produce
 * the same output on any machine — so an absolute byte budget is a legitimate gate, and a
 * regression in it is a fact rather than a measurement artefact.
 *
 * ### What measuring caught
 *
 * Before P-5.3 the console built to **one chunk: 1,410 kB (403 kB gzip)**. Every page — the rule
 * editor, Recharts, the entire workspace — downloaded before an operator could see the login form.
 * Nothing was broken, and nothing had ever been measured. Route splitting plus vendor chunking took
 * the entry chunk to **42.9 kB (13.4 kB gzip)**.
 *
 * ⚠️ This script **fails when `dist/` is missing** rather than skipping. A budget check that
 * silently passes because nobody built first is a check that could not run being reported as one
 * that passed (CONSTRAINTS §44).
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/assets', import.meta.url));

/**
 * Budgets in **raw kB**, with headroom over the measured baseline so ordinary feature work does not
 * trip them — they exist to catch a category change (an eager import of a heavy page, a new
 * dependency landing in the entry chunk), not to police every kilobyte.
 */
const BUDGETS = [
  { name: 'entry (app shell)', match: /^index-.*\.js$/, maxKb: 120 },
  { name: 'investigation workspace route', match: /^InvestigationWorkspace-.*\.js$/, maxKb: 120 },
  { name: 'any single route chunk', match: /^(?!index-|vendor)[A-Za-z].*\.js$/, maxKb: 200 },
  { name: 'stylesheet', match: /\.css$/, maxKb: 90 },
];

/**
 * Vendor is exempt from the per-route budget: it is cached across releases and is bounded by the
 * dependency set rather than by our code. It gets its own, larger ceiling.
 */
const VENDOR_TOTAL_MAX_KB = 1400;

let files;
try {
  files = readdirSync(DIST);
} catch {
  console.error(
    `bundle-budget: FAIL — ${DIST} does not exist. Run \`vite build\` first.\n` +
      'A budget check that skips because nobody built is a check that could not run (CONSTRAINTS §44).',
  );
  process.exit(1);
}

const sized = files.map((name) => ({ name, kb: statSync(`${DIST}/${name}`).size / 1024 }));

const failures = [];
const report = [];

for (const budget of BUDGETS) {
  const matched = sized.filter(
    (file) => budget.match.test(file.name) && !file.name.startsWith('vendor'),
  );
  if (matched.length === 0) {
    failures.push(`${budget.name}: no chunk matched ${budget.match} — the build layout changed`);
    continue;
  }
  const worst = matched.reduce((a, b) => (a.kb > b.kb ? a : b));
  report.push(
    `  ${budget.name.padEnd(32)} ${worst.kb.toFixed(1).padStart(7)} kB / ${String(budget.maxKb).padStart(4)} kB  (${worst.name})`,
  );
  if (worst.kb > budget.maxKb) {
    failures.push(
      `${budget.name}: ${worst.kb.toFixed(1)} kB exceeds ${budget.maxKb} kB (${worst.name})`,
    );
  }
}

const vendorKb = sized
  .filter((file) => file.name.startsWith('vendor'))
  .reduce((total, file) => total + file.kb, 0);
report.push(
  `  ${'vendor (all, cached)'.padEnd(32)} ${vendorKb.toFixed(1).padStart(7)} kB / ${VENDOR_TOTAL_MAX_KB} kB`,
);
if (vendorKb > VENDOR_TOTAL_MAX_KB) {
  failures.push(`vendor total: ${vendorKb.toFixed(1)} kB exceeds ${VENDOR_TOTAL_MAX_KB} kB`);
}

console.log('bundle-budget:\n' + report.join('\n'));

if (failures.length > 0) {
  console.error('\nbundle-budget: FAIL\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`bundle-budget: OK — ${sized.length} asset(s) within budget.`);
