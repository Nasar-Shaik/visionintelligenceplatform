/**
 * Environment loading. `.env` is the ONLY secrets source (ADR-0018) — no external
 * secret manager. In production, the orchestrator injects real environment variables
 * and no `.env` file is present, so loading is best-effort and silent when absent.
 *
 * Uses Node's built-in `process.loadEnvFile()` (Node ≥20.12) — no `dotenv` dependency.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Load a `.env` file into `process.env` once, at process start, before reading config.
 *
 * With no argument, walks up from the current working directory to find the nearest `.env`
 * (up to the filesystem root). This matters for the monorepo: services run with their own
 * package directory as cwd (via `pnpm --filter` / `turbo run dev`), yet the single source of
 * truth `.env` lives at the repo root — so `pnpm dev:all` works with zero per-service config.
 *
 * Pass an explicit `path` to load a specific file (used by the seed script). No-op if no file
 * is found/readable (production injects env directly — not an error).
 */
export function loadDotEnv(path?: string): void {
  try {
    const file = path ?? findNearestEnvFile();
    if (file) process.loadEnvFile(file);
  } catch {
    // .env absent or unreadable — rely on the real process environment. Not an error.
  }
}

/** Walk up from cwd looking for a `.env`; returns the first hit or undefined. */
function findNearestEnvFile(): string | undefined {
  let dir = process.cwd();
  // Bounded walk (repo depth is small); stops at the filesystem root.
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
