#!/usr/bin/env node
/**
 * Import-graph / architecture-boundary enforcement.
 *
 * Statically scans every workspace package's TypeScript sources and fails the
 * build if any import crosses an architectural boundary defined in
 * ./boundaries.json (which itself mirrors docs/architecture/22 & 23).
 *
 * Rules enforced:
 *   - noDeepImports          import a package by its public entry, not internal paths
 *   - noCoreToPlugin         shared libs + services must never import a plugin
 *   - noCrossServiceInternals a service must not import another service's code
 *   - noCycles               the package dependency graph must stay acyclic
 *
 * Zero runtime dependencies (Node built-ins only) so it runs anywhere without install.
 * It is a heuristic, regex-based scanner — deliberately strict and easy to read; it
 * favours a clear false-positive you can waive over a boundary breach slipping through.
 *
 * Usage:  node tools/import-graph/check-imports.mjs  (alias: pnpm check:imports)
 * Exit:   0 clean · 1 violations found · 2 tool/config error
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-graph/boundaries.json'), 'utf8'));

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', 'coverage', '.turbo']);

/** Directories that hold workspace packages, derived from the layer policy. */
const LAYER_PREFIXES = Object.entries(POLICY.layers).map(([name, cfg]) => ({ name, match: cfg.match }));

/** @returns {string|null} layer name for a repo-relative path, or null if outside all layers. */
function layerOf(relPath) {
  const normalized = relPath.split(sep).join('/');
  for (const { name, match } of LAYER_PREFIXES) {
    if (normalized.startsWith(match)) return name;
  }
  return null;
}

/** Recursively collect files under `dir` (absolute) that pass `keep(absPath)`. */
function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), keep, out);
    } else if (keep(join(dir, entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Discover workspace packages: any package.json living under a known layer prefix. */
function discoverPackages() {
  const roots = [...new Set(LAYER_PREFIXES.map((l) => l.match.replace(/\/$/, '')))];
  const packages = [];
  for (const root of roots) {
    const absRoot = join(REPO_ROOT, root);
    const manifests = walk(absRoot, (p) => p.endsWith(`${sep}package.json`));
    for (const manifest of manifests) {
      const pkgDir = dirname(manifest);
      // Skip nested package.json inside an already-found package's node_modules etc.
      const relDir = relative(REPO_ROOT, pkgDir);
      let name;
      try {
        name = JSON.parse(readFileSync(manifest, 'utf8')).name;
      } catch {
        continue;
      }
      if (!name) continue;
      packages.push({ name, dir: pkgDir, relDir, layer: layerOf(relDir) });
    }
  }
  return packages;
}

const SPEC_RE =
  /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Extract import specifiers from a source file, skipping obvious comment lines. */
function extractSpecifiers(absFile) {
  const src = readFileSync(absFile, 'utf8');
  const specs = [];
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(rawLine)) !== null) {
      specs.push(m[1] ?? m[2] ?? m[3]);
    }
  }
  return specs;
}

/** Longest-prefix match of a bare specifier against known package names. */
function matchPackage(spec, byName) {
  if (spec.startsWith('.')) return null;
  let best = null;
  for (const pkg of byName) {
    if (spec === pkg.name || spec.startsWith(`${pkg.name}/`)) {
      if (!best || pkg.name.length > best.name.length) best = pkg;
    }
  }
  return best;
}

function main() {
  const packages = discoverPackages();
  const violations = [];
  const edges = new Set(); // "from -> to" for cycle detection

  for (const pkg of packages) {
    if (pkg.layer === 'tool') continue; // tooling is not part of the runtime graph
    const files = walk(pkg.dir, (p) => SOURCE_EXT.has(p.slice(p.lastIndexOf('.'))));
    for (const file of files) {
      const relFile = relative(REPO_ROOT, file).split(sep).join('/');
      for (const spec of extractSpecifiers(file)) {
        // --- Relative import: must stay inside its own package -------------
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          if (!resolved.startsWith(pkg.dir + sep) && resolved !== pkg.dir) {
            const target = packages.find((p) => resolved.startsWith(p.dir + sep));
            violations.push({
              rule: 'noDeepImports',
              file: relFile,
              spec,
              message: target
                ? `relative import escapes into package "${target.name}" — import it by name, not by path`
                : `relative import escapes the package boundary`,
            });
          }
          continue;
        }

        // --- Bare specifier: only workspace packages are our concern -------
        const target = matchPackage(spec, packages);
        if (!target) continue; // external npm dep — out of scope

        // noDeepImports: any subpath past a package's public entry is forbidden —
        // including a package referencing its own name (use relative imports internally).
        if (POLICY.rules.noDeepImports.enabled && spec !== target.name) {
          violations.push({
            rule: 'noDeepImports',
            file: relFile,
            spec,
            message: `deep import into "${target.name}" — use its public entry "${target.name}"`,
          });
        }

        // A package referencing itself is not a cross-package dependency: no graph
        // edge (avoids a false self-cycle) and cross-layer rules don't apply.
        if (target.name === pkg.name) continue;
        edges.add(`${pkg.name} -> ${target.name}`);

        // noCoreToPlugin
        const r1 = POLICY.rules.noCoreToPlugin;
        if (r1.enabled && r1.from.includes(pkg.layer) && r1.to.includes(target.layer)) {
          violations.push({
            rule: 'noCoreToPlugin',
            file: relFile,
            spec,
            message: `${pkg.layer} "${pkg.name}" imports plugin "${target.name}" — the core must not depend on plugins`,
          });
        }

        // noCrossServiceInternals
        const r2 = POLICY.rules.noCrossServiceInternals;
        if (r2.enabled && r2.from.includes(pkg.layer) && r2.to.includes(target.layer)) {
          violations.push({
            rule: 'noCrossServiceInternals',
            file: relFile,
            spec,
            message: `service "${pkg.name}" imports service "${target.name}" — cross-service calls go via API/events`,
          });
        }

        // noAppToBackend: a frontend app may import shared libs only, never services/plugins.
        const r3 = POLICY.rules.noAppToBackend;
        if (r3?.enabled && r3.from.includes(pkg.layer) && r3.to.includes(target.layer)) {
          violations.push({
            rule: 'noAppToBackend',
            file: relFile,
            spec,
            message: `app "${pkg.name}" imports ${target.layer} "${target.name}" — a UI app is a gateway client; use @vip/contracts for types, call the gateway API for data`,
          });
        }

        // noImportApp: nothing may import a frontend app (apps are dependency-graph leaves).
        const r4 = POLICY.rules.noImportApp;
        if (r4?.enabled && r4.from.includes(pkg.layer) && r4.to.includes(target.layer)) {
          violations.push({
            rule: 'noImportApp',
            file: relFile,
            spec,
            message: `${pkg.layer} "${pkg.name}" imports app "${target.name}" — apps are leaves; the core must never depend on the UI`,
          });
        }
      }
    }
  }

  // noCycles: DFS over the package edge set.
  if (POLICY.rules.noCycles.enabled) {
    const adj = new Map();
    for (const edge of edges) {
      const [from, to] = edge.split(' -> ');
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push(to);
    }
    const WHITE = 0,
      GREY = 1,
      BLACK = 2;
    const color = new Map();
    const stack = [];
    const cycles = [];
    const visit = (node) => {
      color.set(node, GREY);
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GREY) {
          const i = stack.indexOf(next);
          cycles.push([...stack.slice(i), next].join(' -> '));
        } else if (c === WHITE) {
          visit(next);
        }
      }
      stack.pop();
      color.set(node, BLACK);
    };
    for (const node of adj.keys()) if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    for (const cycle of [...new Set(cycles)]) {
      violations.push({ rule: 'noCycles', file: '(package graph)', spec: '', message: `dependency cycle: ${cycle}` });
    }
  }

  // --- Report -----------------------------------------------------------
  const scanned = packages.filter((p) => p.layer !== 'tool');
  if (violations.length === 0) {
    console.log(`import-graph: OK — ${scanned.length} package(s) scanned, ${edges.size} internal edge(s), 0 violations.`);
    for (const p of scanned) console.log(`  · ${p.name} [${p.layer}] ${p.relDir}`);
    process.exit(0);
  }

  console.error(`import-graph: ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ✗ [${v.rule}] ${v.file}`);
    if (v.spec) console.error(`      import "${v.spec}"`);
    console.error(`      ${v.message}\n`);
  }
  console.error('Boundaries are defined in tools/import-graph/boundaries.json (see docs/architecture/22 & 23).');
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error('import-graph: tool error —', err instanceof Error ? err.message : err);
  process.exit(2);
}
