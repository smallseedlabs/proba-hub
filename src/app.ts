import type { FastifyInstance } from 'fastify';
import { createServer } from './server.js';
import { config, type BrainProviderKind } from './config.js';
import { authRoutes, devAuthRoutes } from './routes/auth.js';
import { createFirebaseTokenVerifier, type FirebaseTokenVerifier } from './auth/firebase.js';
import { logger } from './logger.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { readRoutes } from './routes/reads.js';
import { internalRoutes } from './routes/internal.js';
import { wellKnownRoutes } from './routes/well-known.js';
import { startOutboxRelay, stopOutboxRelay } from './services/outbox-relay.js';
import { startAuditRelay, stopAuditRelay } from './audit/relay.js';
import { startAskExpiryJob, stopAskExpiryJob } from './services/ask-expiry.js';
import { CommandProcessor } from './services/command-processor.js';
import { createBrain } from './brain/factory.js';
import type { BrainPort } from './types.js';
import { createAssertionRuntime, type ContextBridgeHubAuth } from './auth/assertions/index.js';
import type { ContextClient } from './brain/context-client.js';
import { createContextClient } from './brain/http-context-client.js';

export interface AppOptions {
  /** Start outbox relay + ask expiry jobs (default true). */
  startBackgroundJobs?: boolean;
  /** Brain provider. Defaults to config.brain.provider (BRAIN_PROVIDER); naming a brainScenario alone selects `mock`. */
  brainProvider?: BrainProviderKind;
  /** Scripted scenario name for the `mock` provider. Defaults to config.brain.scenario (MOCK_BRAIN_SCENARIO). */
  brainScenario?: string;
  /** Inject a brain implementation directly (takes precedence over brainScenario). */
  brain?: BrainPort;
  /** SSE heartbeat interval. Defaults to config.sse.heartbeatIntervalMs. */
  sseHeartbeatIntervalMs?: number;
  /** Failed session-exchange rate limit overrides (tests). */
  authRateLimit?: { rateLimitMax?: number; rateLimitWindowMs?: number };
  /**
   * Firebase ID token verifier. Defaults to one built from FIREBASE_PROJECT_ID
   * (Google's public keys); tests inject one backed by a local key pair.
   */
  firebaseVerifier?: FirebaseTokenVerifier | null;
  /** Overrides AUTH_ALLOWED_EMAIL_DOMAINS. */
  allowedEmailDomains?: readonly string[];
  /** Register POST /dev/login. Defaults to config.auth.devLoginEnabled (never in production). */
  devLogin?: boolean;
  /** Inject assertion / context-reader auth (tests). When omitted, loaded from config. */
  assertionAuth?: ContextBridgeHubAuth;
  /** Inject ContextClient (tests). Not wired into the brain yet. */
  contextClient?: ContextClient;
}

/**
 * Build a fully wired Hub application. Every call returns a new, independent
 * Fastify instance; configuration is injected via options rather than by
 * mutating process.env.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const fastify = await createServer();

  const brain =
    options.brain ??
    createBrain({
      provider: options.brainProvider ?? (options.brainScenario ? 'mock' : undefined),
      scenario: options.brainScenario,
    });
  const processor = new CommandProcessor(brain);

  if (!config.isProduction && (options.devLogin ?? config.auth.devLoginEnabled)) {
    await fastify.register(devAuthRoutes);
  }
  const firebaseVerifier =
    options.firebaseVerifier !== undefined
      ? options.firebaseVerifier
      : config.firebase.projectId
        ? createFirebaseTokenVerifier({ projectId: config.firebase.projectId })
        : null;
  if (!firebaseVerifier && !config.isTest) {
    logger.warn('FIREBASE_PROJECT_ID is not set: sign-in (POST /v1/auth/session) is disabled');
  }
  await fastify.register(authRoutes, {
    prefix: '/v1',
    firebaseVerifier,
    allowedEmailDomains: options.allowedEmailDomains ?? config.auth.allowedEmailDomains,
    ...options.authRateLimit,
  });
  await fastify.register(commandRoutes, { prefix: '/v1', processor });
  await fastify.register(eventRoutes, {
    prefix: '/v1',
    heartbeatIntervalMs: options.sseHeartbeatIntervalMs ?? config.sse.heartbeatIntervalMs,
  });
  await fastify.register(readRoutes, { prefix: '/v1' });

  const assertionAuth =
    options.assertionAuth ??
    (await createAssertionRuntime({
      env: config.env,
      contextReaderEnabled: config.contextBridge.contextReaderEnabled,
      contextBridgeUrl: config.contextBridge.url,
      assertionPrivateKeyFile: config.contextBridge.assertionPrivateKeyFile,
      assertionKeyId: config.contextBridge.assertionKeyId,
      assertionPublicKeyFile: config.contextBridge.assertionPublicKeyFile,
      contextServicePublicKeyFile: config.contextBridge.contextServicePublicKeyFile,
    }));

  await fastify.register(wellKnownRoutes, {
    prefix: '/v1',
    assertionJwks: assertionAuth.assertionJwks,
  });

  if (assertionAuth.contextReaderEnabled) {
    await fastify.register(internalRoutes, { prefix: '/v1/internal', auth: assertionAuth });
  }

  // ContextClient is constructed for later brain wiring (brief 07); not used here.
  const contextClient =
    options.contextClient ??
    createContextClient({
      baseUrl: config.contextBridge.url,
      timeoutMs: config.contextBridge.timeoutMs,
      failureThreshold: config.contextBridge.failureThreshold,
      openMs: config.contextBridge.openMs,
    });
  fastify.decorate('contextClient', contextClient);
  fastify.decorate('assertionAuth', assertionAuth);

  if (options.startBackgroundJobs !== false) {
    await startOutboxRelay();
    // Audit relay: audit_outbox -> Redis Stream (AUDIT_ENABLED / AUDIT_RELAY_ENABLED).
    // Independent of the SSE relay above and of the proba:events pub/sub channel.
    startAuditRelay();
    startAskExpiryJob();
    fastify.addHook('onClose', async () => {
      await stopOutboxRelay();
      await stopAuditRelay();
      stopAskExpiryJob();
    });
  }

  return fastify;
}
