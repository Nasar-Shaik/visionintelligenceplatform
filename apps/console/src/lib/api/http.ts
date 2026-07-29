import type { ApiError, ApiMeta } from '@vip/contracts';

/**
 * Typed gateway HTTP client. The console is a pure client of the API gateway:
 * every request goes to `/api/*` (dev-proxied to the gateway; CORS handled
 * server-side by enabler G-5 in deployed envs). Responses use the platform
 * envelope `{ success, data, meta, error }` (contracts/api-envelope) — this
 * layer unwraps it, returning `data` on success and throwing `ApiRequestError`
 * (carrying the structured `ApiError` + HTTP status) otherwise.
 *
 * Auth: a bearer token is held in memory only (never localStorage — XSS-safe)
 * and injected per request; the auth feature owns its lifecycle (set/clear).
 */

const API_BASE = '/api';

let accessToken: string | null = null;
/** Set/replace the in-memory access token (called by the auth feature). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiError['details'];
  readonly correlationId?: string;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = error.code;
    if (error.details) this.details = error.details;
    if (error.correlationId) this.correlationId = error.correlationId;
  }
}

interface EnvelopeSuccess<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}
interface EnvelopeFailure {
  success: false;
  error: ApiError;
  meta?: ApiMeta;
}
type Envelope<T> = EnvelopeSuccess<T> | EnvelopeFailure;

export interface RequestOptions {
  /** Query parameters — undefined/null values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Extra headers (e.g. `x-tenant-id` on the login call). */
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (cause) {
    throw new ApiRequestError(0, {
      code: 'network_error',
      message: cause instanceof Error ? cause.message : 'Network request failed',
    });
  }

  if (response.status === 204) return undefined as T;

  let payload: Envelope<T> | undefined;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as Envelope<T>;
    } catch {
      // Non-envelope body (e.g. a proxy/HTML error page).
      throw new ApiRequestError(response.status, {
        code: 'invalid_response',
        message: `Unexpected non-JSON response (${response.status})`,
      });
    }
  }

  if (!response.ok || (payload && payload.success === false)) {
    const error: ApiError =
      payload && payload.success === false
        ? payload.error
        : { code: 'http_error', message: `Request failed (${response.status})` };
    throw new ApiRequestError(response.status, error);
  }

  return (payload as EnvelopeSuccess<T> | undefined)?.data as T;
}

export const http = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};
