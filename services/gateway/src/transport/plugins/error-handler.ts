/**
 * Transport plugin: uniform error + not-found handling using the @vip/contracts `ApiError`
 * envelope. Auth failures → 401 (opaque); 5xx details never leak (logged server-side).
 */
import type { ApiError } from '@vip/contracts';
import { AuthError } from '@vip/auth';
import type { FastifyError, FastifyInstance } from 'fastify';

function envelope(error: ApiError): { success: false; error: ApiError } {
  return { success: false, error };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const correlationId = request.id;

    if (error instanceof AuthError) {
      reply
        .status(401)
        .send(envelope({ code: 'unauthenticated', message: 'Unauthorized', correlationId }));
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

    reply
      .status(statusCode)
      .send(envelope({ code: error.code ?? 'bad_request', message: error.message, correlationId }));
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
