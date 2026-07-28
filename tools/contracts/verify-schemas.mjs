#!/usr/bin/env node
/**
 * Contract-testing harness — generated-artifact gate.
 *
 * Runs after `@vip/contracts` codegen and asserts the published JSON Schema
 * artifacts are present, well-formed, and target the pinned draft. This is the
 * seam where consumer-driven contract tests plug in as services arrive
 * (docs/architecture/03 §Contract testing, 21 §3, ADR-0015).
 *
 * Zero runtime dependencies. Exit: 0 pass · 1 fail.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN_DIR = join(REPO_ROOT, 'packages/contracts/generated');
const TARGET_DRAFT = '2020-12';

// The set of contracts that MUST be published. Keep in sync with
// packages/contracts/scripts/generate-json-schema.ts.
const REQUIRED = [
  'event-envelope',
  'event-catalog-entry',
  'event-query',
  'capability-descriptor',
  'capability-registry-record',
  'tenant-context',
  'api-error',
  'config-node',
  'tenant',
  'org-node',
  'user',
  'principal',
  'token-pair',
  'camera',
  'capture-profile',
  'camera-health',
  'stream-status',
  'recording-segment',
  'detection',
  'detection-result',
  'inference-request',
];

const errors = [];

let present = [];
try {
  present = readdirSync(GEN_DIR).filter((f) => f.endsWith('.schema.json'));
} catch {
  console.error(
    `contracts: no generated schemas at ${GEN_DIR}. Run: pnpm --filter @vip/contracts codegen`,
  );
  process.exit(1);
}

for (const name of REQUIRED) {
  const file = `${name}.schema.json`;
  if (!present.includes(file)) {
    errors.push(`missing required schema: ${file}`);
    continue;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(GEN_DIR, file), 'utf8'));
  } catch (e) {
    errors.push(`${file}: not valid JSON — ${e instanceof Error ? e.message : e}`);
    continue;
  }
  if (typeof doc.$schema !== 'string' || !doc.$schema.includes(TARGET_DRAFT)) {
    errors.push(
      `${file}: $schema must target JSON Schema draft ${TARGET_DRAFT} (got ${doc.$schema ?? 'none'})`,
    );
  }
  const hasShape = doc.type || doc.$ref || doc.anyOf || doc.allOf || doc.oneOf || doc.properties;
  if (!hasShape) {
    errors.push(`${file}: schema has no type/shape — likely an empty or broken export`);
  }
}

if (errors.length > 0) {
  console.error(`contracts: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

console.log(
  `contracts: OK — ${REQUIRED.length} schema(s) present, valid JSON, draft ${TARGET_DRAFT}.`,
);
process.exit(0);
