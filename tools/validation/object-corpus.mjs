/**
 * Fetch the pinned real-photograph corpus the object-association measurements were made on.
 *
 *   node tools/validation/object-corpus.mjs            # fetch into .data/corpus/, verify checksums
 *   node tools/validation/object-corpus.mjs --verify   # verify what is already there, fetch nothing
 *
 * ⛔ **The pixels are deliberately not in this repository.** Every image is freely licensed, but the
 * strongest evidence in the set is CC BY-SA, whose share-alike term is a decision about the product's
 * licensing rather than about verification — and `OBJECT_FOOTAGE.md` already establishes that real
 * photographs of real people live outside git. What is committed instead is enough to reproduce the
 * corpus exactly: source URL, licence, author, and a SHA-256 of the bytes that were measured.
 *
 * ⚠️ **A checksum mismatch fails loudly rather than being re-downloaded.** Commons files can be
 * overwritten in place. A measurement quietly re-run against different pixels is worse than one that
 * cannot run at all, because it produces a plausible number that describes nothing.
 *
 * ### Why photographs and not the platform's own fixtures
 *
 * The validation fixtures are authored footage — rectangles a detector reads as `person`. They can
 * prove tracking, timing and geometry, and they can never prove that a model recognises a handbag,
 * because there is no handbag in them. P-8 settled the same point for people and put a real
 * photograph in `infra/docker/fixtures/media/` for exactly this reason. This is that argument
 * applied to the classes association needs.
 *
 * ⭐ Half the corpus is **object-free on purpose** — the negative control. A floor that admits real
 * carried objects is worth nothing until you know what it admits on footage where there are none.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const MANIFEST = join(ROOT, 'docs/validation/object-corpus.json');
const OUT = process.env.VIP_CORPUS_DIR ?? join(ROOT, '.data/corpus');
const VERIFY_ONLY = process.argv.includes('--verify');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
mkdirSync(OUT, { recursive: true });

let ok = 0;
let missing = 0;
let mismatched = 0;

for (const entry of manifest.images) {
  const path = join(OUT, entry.file);
  let bytes = existsSync(path) ? readFileSync(path) : null;

  if (bytes === null) {
    if (VERIFY_ONLY) {
      console.log(`missing  ${entry.file}`);
      missing += 1;
      continue;
    }
    const res = await fetch(entry.url, { headers: { 'user-agent': 'VIP-validation/1.0' } });
    if (!res.ok) {
      console.log(`HTTP ${res.status}  ${entry.file}  ${entry.url}`);
      missing += 1;
      continue;
    }
    bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, bytes);
    /* ⚠️ Commons rate-limits, and a corpus half-fetched is not a corpus. */
    await new Promise((r) => setTimeout(r, 400));
  }

  const digest = sha256(bytes);
  if (digest !== entry.sha256) {
    /* ⛔ Never silently re-fetch. These bytes are not the bytes the numbers describe. */
    console.log(`MISMATCH ${entry.file}\n  expected ${entry.sha256}\n  got      ${digest}`);
    mismatched += 1;
    continue;
  }
  ok += 1;
}

console.log(
  `\n${String(ok)}/${String(manifest.images.length)} verified` +
    (missing > 0 ? `, ${String(missing)} missing` : '') +
    (mismatched > 0 ? `, ${String(mismatched)} MISMATCHED` : ''),
);
console.log(`corpus: ${OUT}`);
if (mismatched > 0) {
  console.log('\n⛔ A mismatched file is not the image the published measurements were made on.');
}
process.exit(mismatched > 0 || (VERIFY_ONLY && missing > 0) ? 1 : 0);
