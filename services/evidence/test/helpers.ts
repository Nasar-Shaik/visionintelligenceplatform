/**
 * Shared test helpers: token minting (identity iss/aud), a deterministic in-memory ObjectStore double,
 * and a service builder wiring the in-memory stores + a fixed clock/id-gen for reproducible tests.
 */
import { signAccessToken } from '@vip/auth';
import type { ObjectBody, ObjectStore, ObjectSummary, PutObjectInput } from '@vip/storage';
import { TenantScope } from '@vip/tenancy';
import { EvidenceService } from '../src/application/evidence-service.js';
import { InMemoryEvidenceStore } from '../src/adapters/in-memory-evidence-store.js';
import { InMemoryCustodyLog } from '../src/adapters/in-memory-custody-log.js';

export const SECRET = 'test-secret-at-least-16-chars';

export function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}

export const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

/** A deterministic, dependency-free ObjectStore over a Map — for pure service unit tests. */
export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();

  async put(input: PutObjectInput): Promise<void> {
    const body =
      typeof input.body === 'string'
        ? new TextEncoder().encode(input.body)
        : new Uint8Array(input.body);
    this.objects.set(input.key, {
      body,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
  }
  async get(key: string): Promise<ObjectBody> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`not found: ${key}`);
    return {
      body: o.body,
      contentLength: o.body.byteLength,
      ...(o.contentType ? { contentType: o.contentType } : {}),
    };
  }
  async list(prefix: string): Promise<ObjectSummary[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.byteLength }));
  }
  async head(key: string): Promise<ObjectSummary | null> {
    const o = this.objects.get(key);
    return o ? { key, size: o.body.byteLength } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async presignPut(key: string, ttlSeconds: number, contentType: string): Promise<string> {
    return `signed-put://${key}?ttl=${ttlSeconds}&ct=${contentType}`;
  }
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return `signed://${key}?ttl=${ttlSeconds}`;
  }
}

export interface Harness {
  service: EvidenceService;
  objectStore: FakeObjectStore;
  store: InMemoryEvidenceStore;
  custody: InMemoryCustodyLog;
  scope: (tenantId: string) => TenantScope;
  /** Put a fake object at the tenant-prefixed key and return its tenant-relative key. */
  putObject: (
    tenantId: string,
    relKey: string,
    bytes: string,
    contentType: string,
  ) => Promise<string>;
}

export function buildHarness(
  opts: { downloadTtlSeconds?: number; defaultRetentionDays?: number } = {},
): Harness {
  const objectStore = new FakeObjectStore();
  const store = new InMemoryEvidenceStore();
  const custody = new InMemoryCustodyLog();
  let n = 0;
  const service = new EvidenceService({
    store,
    custody,
    objectStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    downloadTtlSeconds: opts.downloadTtlSeconds ?? 900,
    defaultRetentionDays: opts.defaultRetentionDays ?? 0,
  });
  return {
    service,
    objectStore,
    store,
    custody,
    scope: (t) => TenantScope.fromTenantId(t),
    putObject: async (tenantId, relKey, bytes, contentType) => {
      await objectStore.put({ key: `${tenantId}/${relKey}`, body: bytes, contentType });
      return relKey;
    },
  };
}
