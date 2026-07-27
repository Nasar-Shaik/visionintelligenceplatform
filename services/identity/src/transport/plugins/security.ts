/**
 * Transport plugin: baseline security headers (secure-by-design). Even though this
 * service normally sits behind the gateway, defence-in-depth means every service sets
 * sane headers itself. This is an API (JSON) service, so the browser-oriented CSP is off.
 */
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, { contentSecurityPolicy: false });
}
