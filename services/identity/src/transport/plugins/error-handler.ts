/**
 * Transport plugin: uniform error + not-found handling. Every failure response uses the
 * public API envelope `{ success:false, error }` from @vip/contracts (docs/architecture/21 §1),
 * carries the request id as `correlationId` for tracing (docs/architecture/16), and never
 * leaks internal 5xx details to the client (they're logged server-side instead).
 */
import type { ApiError } from '@vip/contracts';
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
    const statusCode = error.statusCode ?? 500;
    const correlationId = request.id;

    if (statusCode >= 500) {
      // Log the real cause; return an opaque message.
      request.log.error({ err: error, correlationId }, 'unhandled error');
      reply
        .status(statusCode)
        .send(
          envelope({ code: 'internal_error', message: 'Internal Server Error', correlationId }),
        );
      return;
    }

    // 4xx — safe to surface. Map Fastify schema-validation failures to field details.
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
