# Changelog

All notable changes to proba-hub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sign-in with Firebase Authentication: `POST /v1/auth/session` verifies a
  Firebase ID token against Google's public keys (no service account) and
  exchanges it for a revocable Hub session token. Configure `FIREBASE_PROJECT_ID`.
- Users are upserted by Firebase uid (migration `003_firebase_auth`: `firebase_uid`,
  `email_verified`, `last_sign_in_at`); optional `AUTH_ALLOWED_EMAIL_DOMAINS`.

### Removed

- Hub-managed passwords: `POST /v1/auth/login`, `npm run user:create` and
  `users.password_hash` (dropped by migration 003, which also signs out
  password sessions). `AUTH_LOGIN_RATE_LIMIT_*` is replaced by
  `AUTH_SESSION_RATE_LIMIT_*`.

### Changed

- Pinned `@smallseedlabs/proba-protocol` to the `v0.1.2` release tag (same commit `c643d52`).

### Fixed

- SSE: listener is registered before the Last-Event-ID replay, so events committed
  during the replay are no longer lost; per-connection seq de-duplication and
  Postgres gap-fill give in-order, exactly-once delivery
- SSE: multiple connections per user are supported; closing one no longer
  unregisters the others; streams are ended on app shutdown
- SSE: response is hijacked from Fastify and keeps CORS headers
- Outbox relay: publisher is single-flight, ordered by (user, seq) and uses
  `FOR UPDATE SKIP LOCKED`; relay is kicked after COMMIT instead of before
- Commands: payloads are validated against their per-type schema (invalid
  payloads are rejected with `validation_error` instead of failing in the DB)
- Commands: idempotency is race-safe (`INSERT ... ON CONFLICT DO NOTHING`)
- Commands: failed brain outputs roll back to a savepoint so the error event
  and command row still commit
- Ask expiry: user lookup joined through threads (asks has no user_id); guarded
  against double expiry
- Polling: non-numeric `after` returns 400

### Changed

- `buildApp(options)` factory replaces the module-level singleton; brain scenario
  and SSE heartbeat are injectable (tests no longer mutate `process.env`)
- `@smallseedlabs/proba-protocol` pinned to the main merge commit of
  proba-protocol PR #3 (`c643d52`); switch to `#v0.1.2` once tagged
- Docker Compose host ports are overridable (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `HUB_HOST_PORT`)
- CI fails on any skipped/todo test and requires the SSE and concurrency suites

## [0.1.0] - 2024-10-19

### Added

- Initial v0.1 release of proba-hub
- Fastify-based HTTP server with structured JSON logging
- PostgreSQL database with migration system
- Redis pub/sub for multi-instance event relay
- POST /v1/commands endpoint with 202 response and idempotency
- GET /v1/events SSE stream with Last-Event-ID resume and heartbeats
- GET /v1/events?after=seq polling fallback
- REST read endpoints: /v1/threads, /v1/messages, /v1/inbox, /v1/goals
- Command processing with transactional writes (command + events + outbox)
- Outbox relay pattern for reliable event delivery across instances
- Asks implementation with blocking, max 3 questions, expiry, and onExpire actions
- Controls (pause/resume/kill) bypassing brain
- BrainPort interface for brain integration
- MockBrain with YAML scenario support:
  - happy_path: Full conversation flow
  - approval_edit: User edits approval percentage
  - expired_ask: Ask expiry handling
  - clarification_loop: Multiple clarification rounds (capped at 2)
  - malformed_output: Error handling for invalid brain outputs
- Dev authentication stub with JWT tokens
- Health and readiness endpoints
- Seed data with demo user and goal
- Docker multi-stage build (non-root user)
- Docker Compose setup with Postgres and Redis
- Docker Swarm stack file for production deployment
- GitHub Actions CI: lint, typecheck, tests, integration tests, docker build
- Comprehensive README with architecture diagram and curl examples
- CONTRIBUTING.md with development guidelines
- Issue and PR templates
- Apache License 2.0

### Dependencies

- @smallseedlabs/proba-protocol from branch cursor/add-prepare-script-3665
  - **TODO**: Switch to v0.1.2 tag once released

### Notes

- This is a PUBLIC repository - no secrets committed
- Uses .env.example pattern for configuration
- Mock brain scenarios allow testing without real AI
- Multi-instance support via outbox relay
- Sequential events per user with no gaps
- Idempotent command processing

[0.1.0]: https://github.com/smallseedlabs/proba-hub/releases/tag/v0.1.0
