# Changelog

All notable changes to proba-hub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `docker-compose.yml`: every published port is bound to `127.0.0.1`; no password has a default (`POSTGRES_PASSWORD`,
  `REDIS_PASSWORD`, `JWT_SECRET` are `${NAME:?...}`); Redis runs with an ACL user and password (no anonymous access) and AOF.
  `scripts/generate-local-env.sh` writes a local `.env` with random values. **Breaking for local setups**: run it (and
  `docker compose down -v` once, because the old Postgres volume holds the old password) before `docker compose up`.
- CI job `Compose security` (`scripts/check-compose-security.mjs`) fails on a non-loopback port, a default or literal password,
  or a required variable that is not really required.
- `NODE_ENV=production`: the Hub refuses to start when `REDIS_URL` has no password (`RedisPasswordRequiredError`); `rediss://` (TLS) is supported.
- `deploy/stack.yml`: Redis with an ACL user and password.
- `.github/rulesets/main.json` and `docs/BRANCH_PROTECTION.md`: branch protection for `main` (to be applied by a repository admin).

### Added

- Audit publisher port: the audit relay publishes through the publish half of proba-audit's `EventBus`, and
  `AUDIT_PUBLISHER` picks the adapter (`redis` default, `log`). Redis is loaded only when chosen. An unknown
  value fails at startup.
- CI check `Vendored proba-audit matches pin`: `src/audit/vendor/proba-audit/UPSTREAM_COMMIT` pins the
  proba-audit commit and `scripts/check-vendored-audit.mjs` diffs the vendored copy against it.

- Optional raw text on audit events (`AUDIT_CONTENT_ENABLED`, default `false`): `thread.message_received`,
  `brain.reply_generated`, `brain.explanation_generated` and `brain.clarification_requested` carry the text in the protocol 0.3.3
  `content` field, in the same transaction and outbox row, with passwords, tokens, API keys, private keys and card numbers masked
  (`maskSecretsInText`, "secrets only": ordinary text stays as written) and long text truncated and flagged. `details.textLength` is kept.

### Changed

- Audit actions are now the specific names of the protocol v0.3.1 catalog: `goal.created|updated|
  status_changed|clarification_answered|budget_proposed|budget_approved|budget_declined`, `budget.evaluated`,
  `stream.connected|disconnected`, `control.paused|resumed|emergency_stopped` (the `kill` command),
  `thread.created|message_received|access_denied`, `tool.proposed`, `brain.reply_generated|
  explanation_generated|clarification_requested`. They replace `data_access.read|write`,
  `policy.evaluated|denied`, `config.changed`, `tool.called` and `brain.clarify_requested`, which are
  never emitted any more. The event `category` and default `riskLevel` come from `AUDIT_ACTION_INFO`
  (not the action prefix). Anything querying the old names in ClickHouse must follow.
- `@smallseedlabs/proba-protocol` is pinned to `v0.3.1` (was `v0.2.0`).
- `@smallseedlabs/proba-protocol` is pinned to the commit of v0.3.3's PR (`2fdfddf`) until `v0.3.3` is tagged; then pin `#v0.3.3`.

### Added

- Unit test that scans the code's audit actions against `AUDIT_ACTION_INFO` and fails on any
  `generic` or `alias` action; `HubAudit.emit` refuses them at runtime.

- Audit trail: every action emits a protocol v0.2.0 `AuditEvent` through a transactional
  outbox (`audit_outbox`, migration 004) and a relay to the `proba.audit.events` Redis Stream
  (`AUDIT_ENABLED`, `AUDIT_RELAY_ENABLED`, `AUDIT_STREAM`, `AUDIT_WORKSPACE_ID`). One traceId per
  request (`clientMsgId` for commands), on every log line and in the `X-Trace-Id` response header.
  See README "Audit trail".

- Sign-in with Firebase Authentication: `POST /v1/auth/session` verifies a
  Firebase ID token against Google's public keys (no service account) and
  exchanges it for a revocable Hub session token. Configure `FIREBASE_PROJECT_ID`.
- Users are upserted by Firebase uid (migration `003_firebase_auth`: `firebase_uid`,
  `email_verified`, `last_sign_in_at`); optional `AUTH_ALLOWED_EMAIL_DOMAINS`.

### Fixed

- The Hub reads `JWT_SECRET_FILE` (Docker/Swarm secret), which takes precedence over
  `JWT_SECRET`; it now refuses to start in production without a secret or with the
  development default (the Swarm stack already set `JWT_SECRET_FILE`, which was ignored).
- The production image can run migrations: `npm run build` copies the `.sql` files into
  `dist/`, `node dist/db/migrate-cli.js` (`npm run migrate:prod`) needs no tsx, and
  compose/stack have a one-shot `migrate` service. Runners are serialized by an advisory lock.

### Removed

- Hub-managed passwords: `POST /v1/auth/login`, `npm run user:create` and
  `users.password_hash` (dropped by migration 003, which also signs out
  password sessions). `AUTH_LOGIN_RATE_LIMIT_*` is replaced by
  `AUTH_SESSION_RATE_LIMIT_*`.

### Changed

- The default workspace is now `seedbed` ("Seedbed"); it was `default` ("My workspace").
  Request logging is one `request completed` line per request (with `traceId`).

- Pinned `@smallseedlabs/proba-protocol` to the `v0.2.0` release tag (`5444c34`; was `v0.1.2`). Additive: adds the `/audit` subpath.

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
