/**
 * The trust boundary. The gateway resolves the TenantContext from a validated access token and
 * forwards it to upstream services as internal headers — after **stripping any client-supplied
 * context headers**, so a downstream service can trust `x-tenant-id`/`x-principal-id` iff it came
 * from the gateway (docs/architecture/phase1/AUTHENTICATION.md §Data flow, TENANT_ARCHITECTURE §2).
 */
import type { AccessClaims } from '@vip/auth';

/** Context headers the gateway injects. Downstream services read these (never client-set ones). */
export function forwardHeaders(claims: AccessClaims): Record<string, string> {
  return {
    'x-tenant-id': claims.tenantId,
    'x-principal-id': claims.principalId,
    'x-roles': claims.roles.join(','),
  };
}

/** Client-supplied headers that must be dropped before forwarding (spoofing prevention). */
export const STRIPPED_CLIENT_HEADERS = [
  'x-tenant-id',
  'x-principal-id',
  'x-roles',
  // Internal service-to-service key — clients must never be able to inject it through the gateway
  // (it authenticates trusted internal callers only, e.g. media → camera credential resolve).
  'x-internal-key',
  // hop-by-hop
  'host',
  'connection',
  'content-length',
] as const;

/** Build the upstream header set: incoming headers minus stripped ones, plus trusted context. */
export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  claims: AccessClaims,
): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = new Set<string>(STRIPPED_CLIENT_HEADERS);
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || strip.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return { ...out, ...forwardHeaders(claims) };
}

/**
 * Trust headers stripped on the PUBLIC auth passthrough (login/refresh/logout — no token yet).
 * `x-tenant-id` is deliberately NOT stripped here: on login it is the tenant the caller wants to
 * authenticate against — a lookup scope, not a privilege claim (credentials are still verified by
 * identity). The privilege headers (`x-principal-id`, `x-roles`) and the internal key are stripped
 * so a client can never forge an identity or an internal caller on a public route.
 */
export const PUBLIC_STRIPPED_HEADERS = [
  'x-principal-id',
  'x-roles',
  'x-internal-key',
  'host',
  'connection',
  'content-length',
] as const;

/** Build headers for the public auth passthrough: incoming minus trust headers, no injected context. */
export function buildPublicUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = new Set<string>(PUBLIC_STRIPPED_HEADERS);
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || strip.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}
