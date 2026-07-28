/**
 * Transport plugin: uniform error + not-found handling. Every failure response uses the public
 * API envelope `{ success:false, error }` from @vip/contracts (docs/architecture/21 §1), carries
 * the request id as `correlationId`, and never leaks internal 5xx details to the client.
 * A tenancy violation is always an opaque 403 (fail-closed) — never reveal the targeted record.
 */
import type { ApiError } from '@vip/contracts';
import { TenancyError } from '@vip/tenancy';
import { AuthError } from '@vip/auth';
import type { FastifyError, FastifyInstance } from 'fastify';

interface ErrorEnvelope {
  success: false;
  error: ApiError;
}

function envelope(error: ApiError): ErrorEnvelope {
  return { success: false, error };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const correlationId = request.id;

    // Authentication failure → opaque 401 (no user/tenant enumeration).
    if (error instanceof AuthError) {
      reply
        .status(401)
        .send(envelope({ code: 'unauthenticated', message: 'Unauthorized', correlationId }));
      return;
    }

    // Tenancy violation → fail-closed 403, opaque message. Real reason logged server-side.
    if (error instanceof TenancyError) {
      request.log.warn({ correlationId, code: error.code }, 'tenancy violation refused');
      reply.status(403).send(envelope({ code: 'forbidden', message: 'Forbidden', correlationId }));
      return;
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, correlationId }, 'unhandled error');
      reply
        .status(statusCode)
        .send(
          envelope({ code: 'internal_error', message: 'Internal Server Error', correlationId }),
        );
      return;
    }

    const details = error.validation?.map((v) => ({
      path: v.instancePath || (v.params?.['missingProperty'] as string | undefined) || '',
      message: v.message ?? 'invalid',
    }));

    reply.status(statusCode).send(
      envelope({
        code: error.code ?? 'bad_request',
        message: error.message,
        correlationId,
        ...(details && details.length > 0 ? { details } : {}),
      }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(
      envelope({
        code: 'not_found',
        message: `Route ${request.method} ${request.url} not found`,
        correlationId: request.id,
      }),
    );
  });
}
