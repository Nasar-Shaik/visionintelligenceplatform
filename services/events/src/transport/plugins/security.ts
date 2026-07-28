/**
 * Transport plugin: baseline security headers (secure-by-design, defence-in-depth). This is an
 * API (JSON) service behind the gateway, so the browser-oriented CSP is off.
 */
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, { contentSecurityPolicy: false });
}
