import type { FastifyInstance } from 'fastify';
import type { JSONWebKeySet } from 'jose';

export interface WellKnownRoutesOptions {
  assertionJwks: JSONWebKeySet;
}

/**
 * Public, cacheable JWKS of Hub act-as assertion verification keys (no secrets).
 */
export async function wellKnownRoutes(fastify: FastifyInstance, options: WellKnownRoutesOptions) {
  fastify.get('/.well-known/assertion-keys', async (_request, reply) => {
    reply
      .header('Cache-Control', 'public, max-age=300, must-revalidate')
      .header('Content-Type', 'application/json; charset=utf-8')
      .send(options.assertionJwks);
  });
}
