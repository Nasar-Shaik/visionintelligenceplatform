/** Small transport helpers shared by the identity routes: success envelope + schema-validated body. */
import type { z } from 'zod';
import { badRequest } from '../application/errors.js';

export function success<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/** Parse a body against a contract schema, or fail with a 400 carrying the first field issue. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(
      first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid body',
    );
  }
  return result.data;
}
