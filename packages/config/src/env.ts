/**
 * Environment loading. `.env` is the ONLY secrets source (ADR-0018) — no external
 * secret manager. In production, the orchestrator injects real environment variables
 * and no `.env` file is present, so loading is best-effort and silent when absent.
 *
 * Uses Node's built-in `process.loadEnvFile()` (Node ≥20.12) — no `dotenv` dependency.
 */

/**
 * Load a `.env` file into `process.env` once, at process start, before reading config.
 * No-op if the file is missing/unreadable (production injects env directly).
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // .env absent or unreadable — rely on the real process environment. Not an error.
  }
}
