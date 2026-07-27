/**
 * Public API response envelope `{ success, data, meta, error }`
 * (docs/architecture/21-API-ARCHITECTURE.md §1). Every REST response uses this shape.
 */
import { z } from 'zod';

/** Structured API error. `code` is a stable machine string; `message` is human-readable. */
export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  /** Optional field-level validation details. */
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** Correlation id for tracing this failure across services (docs/architecture/16). */
  correlationId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Pagination / response metadata. */
export const ApiMeta = z
  .object({
    page: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
    correlationId: z.string().optional(),
  })
  .partial();
export type ApiMeta = z.infer<typeof ApiMeta>;

/**
 * Build a typed success/error envelope for a given data schema.
 * Usage: `const CameraResponse = apiEnvelope(CameraSchema);`
 */
export function apiEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),
      data,
      meta: ApiMeta.optional(),
      error: z.undefined().optional(),
    }),
    z.object({
      success: z.literal(false),
      error: ApiError,
      meta: ApiMeta.optional(),
      data: z.undefined().optional(),
    }),
  ]);
}
