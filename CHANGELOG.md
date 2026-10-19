# Changelog

All notable changes to proba-hub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
