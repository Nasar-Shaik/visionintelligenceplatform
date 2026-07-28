/**
 * Internal service-to-service authentication. Some calls are not user requests and carry no JWT —
 * `media` (P1-4) asks camera to resolve a stream's decrypted credentials. Those are authenticated
 * by a shared `INTERNAL_API_KEY` presented as `x-internal-key` and compared in CONSTANT TIME.
 * The gateway strips any client-supplied `x-internal-key`, so this can only be satisfied by a
 * trusted internal caller (defence-in-depth). A machine principal / mTLS replaces this later.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError } from '../../application/errors.js';

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Build a preHandler that requires a valid `x-internal-key`. */
export function requireInternalKey(expectedKey: string): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const provided = request.headers['x-internal-key'];
    if (typeof provided !== 'string' || !constantTimeEqual(provided, expectedKey)) {
      throw new AppError(401, 'unauthenticated', 'invalid internal credentials');
    }
  };
}
