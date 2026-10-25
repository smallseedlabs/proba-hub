# proba-hub

> **Interaction Hub** - Protocol service for Proba, an AI-native platform for testing products with ads.

[![CI](https://github.com/smallseedlabs/proba-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/smallseedlabs/proba-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Overview

`proba-hub` is the central microservice that implements the [proba-protocol](https://github.com/smallseedlabs/proba-protocol) transport layer. It handles command ingestion, event streaming, and coordinates between the web client and the AI brain.

## Architecture

```mermaid
graph TB
    Client[proba-web]
    Hub[proba-hub]
    Brain[AI Brain]
    PG[(PostgreSQL)]
    Redis[(Redis)]
    
    Client -->|POST /v1/commands| Hub
    Client <-->|SSE /v1/events| Hub
    Client -->|GET /v1/threads, /v1/goals| Hub
    
    Hub -->|Process| Brain
    Brain -->|BrainOutput| Hub
    
    Hub -->|Store| PG
    Hub -->|Pub/Sub| Redis
    
    Hub -->|Read| PG
    
    subgraph "Transaction Boundary"
        Hub -->|1. Store Command| PG
        Hub -->|2. Process via Brain| Brain
        Hub -->|3. Store Events| PG
        Hub -->|4. Add to Outbox| PG
    end
    
    subgraph "Multi-Instance Support"
        Redis -->|Relay| Hub
        Hub -->|SSE Push| Client
    end
```

### Key Design Principles

1. **Command-Event Separation**: Commands are accepted with 202, processed async, events streamed back
2. **Idempotency**: `(userId, clientMsgId)` uniqueness ensures safe retries
3. **Transactional Consistency**: Command + Events + Outbox written atomically
4. **Multi-Instance Ready**: Outbox → Redis pub/sub → SSE allows horizontal scaling
5. **Sequential Events**: Per-user sequence numbers guarantee ordered delivery with no gaps

## Stack

- **Runtime**: Node.js 20
- **Language**: TypeScript 5
- **HTTP Framework**: Fastify 4
- **Database**: PostgreSQL 16 with real migrations
- **Cache/Pub-Sub**: Redis 7
- **Protocol**: [@smallseedlabs/proba-protocol](https://github.com/smallseedlabs/proba-protocol)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- (Optional) PostgreSQL 16 & Redis 7 for local development

### Installation

```bash
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:

- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `FIREBASE_PROJECT_ID`: Firebase project whose ID tokens are accepted for sign-in
- `JWT_SECRET` / `JWT_SECRET_FILE`: Signs Hub session tokens. `JWT_SECRET_FILE` (e.g. a Swarm secret at `/run/secrets/jwt_secret`) takes precedence. With `NODE_ENV=production` the Hub refuses to start if neither is set or the value is the development default
- `CORS_ORIGIN`: Allowed origin for CORS (e.g., `http://localhost:5173`)
- `MOCK_BRAIN_SCENARIO`: Which YAML scenario to run (`happy_path`, `approval_edit`, etc.)

### Running with Docker Compose

The easiest way to run the full stack:

```bash
# JWT_SECRET is required: the production image refuses a missing/dev-default secret
export JWT_SECRET="$(openssl rand -base64 48)"

# Start all services (postgres + redis, then the one-shot `migrate` job, then hub)
docker compose up -d

# View logs
docker compose logs -f hub

# Re-run migrations by hand (compiled entry point, no tsx; also runs on `up`)
docker compose run --rm migrate

# Seed demo data is a development tool (needs tsx + sources): run `npm run seed`
# on the host against the published Postgres port.

# Stop all services
docker compose down
```

The Hub will be available at `http://localhost:3000`.

### Running Locally (Development)

```bash
# Start Postgres and Redis via Docker Compose
docker compose up -d postgres redis

# Run migrations
npm run migrate

# Seed demo data
npm run seed

# Start in dev mode (with hot reload)
npm run dev
```

If ports 5432/6379/3000 are already taken on your machine, override the host
ports (and point `DATABASE_URL`/`REDIS_URL` in your `.env` at them):

```bash
POSTGRES_HOST_PORT=55432 REDIS_HOST_PORT=56379 docker compose up -d postgres redis
```

### Running the integration tests locally

Integration tests run against real Postgres and Redis (never point them at a
database you care about: they `TRUNCATE` tables).

```bash
docker compose up -d postgres redis
docker compose exec postgres psql -U proba -d proba_hub -c "CREATE DATABASE proba_hub_test"
export DATABASE_URL=postgresql://proba:proba@localhost:5432/proba_hub_test
export REDIS_URL=redis://localhost:6379
npm run migrate
npm run test:integration       # or test:integration:ci (fails on any skipped test)
```

### Building

```bash
npm run build
npm start
```

## API Endpoints

### Authentication

Users sign in with **Firebase Authentication** (email/password or Google) in
proba-web. The Hub never sees passwords. It verifies the Firebase ID token and
exchanges it for its own revocable session token, which is then used for
`/v1/commands`, `/v1/events` (header or `?token=` for SSE, redacted in logs) and
every read.

ID tokens are verified without a service account: RS256 signature against
Google's public keys
(`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`,
fetched and cached by [`jose`](https://github.com/panva/jose)), then
`iss = https://securetoken.google.com/<FIREBASE_PROJECT_ID>`,
`aud = <FIREBASE_PROJECT_ID>`, `exp`/`iat` (5 s clock tolerance), `auth_time`
in the past and a non-empty `sub`. Set `FIREBASE_PROJECT_ID`; without it the
endpoint answers `503 auth_not_configured`.

**POST** `/v1/auth/session`

```bash
curl -X POST http://localhost:3000/v1/auth/session \
  -H "Content-Type: application/json" \
  -d '{"idToken": "<Firebase ID token from getIdToken()>"}'
```

Response (the contract proba-web expects):
```json
{
  "token": "eyJhbG...",
  "user": { "id": "...", "email": "ana@example.com", "name": "Ana Example" },
  "workspaces": [{ "id": "default", "name": "My workspace" }],
  "expiresAt": "2026-10-27T00:00:00.000Z"
}
```

Users are upserted by Firebase uid (`users.firebase_uid`), keeping email,
display name (`users.name`) and `email_verified` current. An existing account
without a Firebase uid is linked on first sign-in only if Firebase reports the
email as verified.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | No `idToken` (the body is never echoed) |
| 401 | `token_expired` | ID token expired: get a fresh one and retry once |
| 401 | `invalid_token` | Bad signature, wrong `aud`/`iss`, bad `auth_time`/`sub` |
| 403 | `email_required` | The Firebase account has no email |
| 403 | `email_not_verified` | Would link an existing account with an unverified email |
| 403 | `not_allowed` | Outside `AUTH_ALLOWED_EMAIL_DOMAINS` (when set) |
| 409 | `account_conflict` | Email already linked to another Firebase user |
| 429 | `rate_limited` | Too many failed exchanges from this IP (`AUTH_SESSION_RATE_LIMIT_MAX`) |
| 503 | `auth_not_configured` | `FIREBASE_PROJECT_ID` not set |

Workspaces are not modelled yet; every user gets one `default` workspace.

**POST** `/v1/auth/logout` (Bearer token) deletes the Hub session: the token
stops working immediately for `/v1/commands`, `/v1/events` and every read.
Returns `204`. proba-web also signs out of Firebase.

**GET** `/v1/auth/me` (Bearer token) returns `{ user, workspaces }`.

Accounts are managed in the Firebase console (Authentication > Users). To
restrict who can sign in, set `AUTH_ALLOWED_EMAIL_DOMAINS`. Without the Admin
SDK the Hub cannot see Firebase refresh-token revocation; to cut off a user,
disable them in Firebase and delete their rows from `sessions`
(`DELETE FROM sessions WHERE user_id = ...`).

**POST** `/dev/login` (development and tests only)

Password-less login by email. It is never registered when `NODE_ENV=production`
(and can be switched off elsewhere with `DEV_LOGIN_ENABLED=false`). proba-web
does not use it.

```bash
curl -X POST http://localhost:3000/dev/login \
  -H "Content-Type: application/json" \
  -d '{"email": "demo@proba.example", "name": "Demo User"}'
```

Use this token in subsequent requests as `Authorization: Bearer <token>` or `?token=<token>` for SSE.

### Commands

**POST** `/v1/commands`

Submit a command. Returns `202 Accepted` immediately.

```bash
curl -X POST http://localhost:3000/v1/commands \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "command",
    "clientMsgId": "550e8400-e29b-41d4-a716-446655440000",
    "type": "create_goal",
    "threadId": "<thread-id>",
    "payload": {
      "title": "Launch Q4 Product Campaign",
      "description": "Promote our new product feature",
      "constraints": ["family-friendly"],
      "budget": {
        "daily": 100,
        "total": 3000,
        "currency": "USD"
      }
    },
    "sentAt": "2024-10-01T10:00:00Z"
  }'
```

Response:
```json
{
  "status": "accepted",
  "clientMsgId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Events

**GET** `/v1/events`

Server-Sent Events stream. Supports `Last-Event-ID` header for reconnection.

Delivery guarantees per connection: events are delivered in `seq` order with no
duplicates and no gaps. The live listener is registered before the
`Last-Event-ID` replay is read; live events queue behind the replay; any event
with `seq <= lastSent` is dropped and a jump in `seq` is back-filled from
Postgres. Heartbeats are SSE comments (`: heartbeat`) every
`SSE_HEARTBEAT_INTERVAL_MS`; the stream starts with a `: connected` comment.
A malformed `Last-Event-ID` is rejected with `400`.

```bash
curl -N http://localhost:3000/v1/events?token=<token>
```

**GET** `/v1/events?after=<seq>`

Polling fallback.

```bash
curl http://localhost:3000/v1/events?after=5 \
  -H "Authorization: Bearer <token>"
```

### Reads

**GET** `/v1/threads` - List user's threads  
**GET** `/v1/messages?threadId=<id>` - Get messages in a thread  
**GET** `/v1/inbox` - Get inbox items  
**GET** `/v1/goals` - List user's goals  

### Health Checks

**GET** `/health` - Liveness probe  
**GET** `/ready` - Readiness probe (checks DB connection)

## Testing the Happy Path

After seeding, test the full flow:

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:3000/dev/login \
  -H "Content-Type: application/json" \
  -d '{"email": "demo@proba.example"}' | jq -r .token)

# 2. Get demo user threads
THREAD_ID=$(curl -s http://localhost:3000/v1/threads \
  -H "Authorization: Bearer $TOKEN" | jq -r .threads[0].id)

# 3. Subscribe to events (open in another terminal)
curl -N "http://localhost:3000/v1/events?token=$TOKEN"

# 4. Send a create_goal command
curl -X POST http://localhost:3000/v1/commands \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"kind\": \"command\",
    \"clientMsgId\": \"$(uuidgen)\",
    \"type\": \"create_goal\",
    \"threadId\": \"$THREAD_ID\",
    \"payload\": {
      \"title\": \"Test Campaign\",
      \"description\": \"Testing the happy path\",
      \"constraints\": [\"family-friendly\"],
      \"budget\": {
        \"daily\": 100,
        \"total\": 1000,
        \"currency\": \"USD\"
      }
    },
    \"sentAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"

# 5. Watch events in the SSE terminal
# You should see a "clarify" ask event

# 6. Answer the ask
ASK_ID=<from-event>
curl -X POST http://localhost:3000/v1/commands \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"kind\": \"command\",
    \"clientMsgId\": \"$(uuidgen)\",
    \"type\": \"answer_ask\",
    \"threadId\": \"$THREAD_ID\",
    \"payload\": {
      \"askId\": \"$ASK_ID\",
      \"askType\": \"clarify\",
      \"choice\": \"approve\",
      \"values\": {
        \"audience\": \"active\"
      }
    },
    \"sentAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"

# Continue the flow through plan approval and action approval
```

## Development

### Scripts

- `npm run dev` - Start with hot reload
- `npm run build` - Compile TypeScript
- `npm run lint` - Run ESLint
- `npm run typecheck` - TypeScript type checking
- `npm test` - Run unit tests
- `npm run test:integration` - Run integration tests (needs Postgres + Redis)
- `npm run test:ci` / `npm run test:integration:ci` - Same, plus a JSON report check
  that fails on any skipped/todo test and requires the SSE and concurrency suites
- `npm run migrate` - Run database migrations (tsx, from `src/`)
- `npm run migrate:prod` - Run them with the compiled entry point (`node dist/db/migrate-cli.js`, what the image and the `migrate` compose/stack job run)
- `npm run seed` - Seed demo data

### Mock Brain Scenarios

The mock brain uses YAML scenario files in `src/brain/scenarios/`:

- `happy_path.yaml` - Full happy path with clarify → plan → approval → decision
- `approval_edit.yaml` - User edits an approval (e.g., +20% → +10%)
- `expired_ask.yaml` - Ask expires with onExpire action
- `clarification_loop.yaml` - Multiple clarification rounds (capped at 2)
- `malformed_output.yaml` - Simulates brain error handling

Set via `MOCK_BRAIN_SCENARIO` environment variable, or inject it in code/tests:
`buildApp({ brainScenario: 'approval_edit' })`.

The default applies to every new conversation. A single goal (or first
message) can pick another scenario by including `#<scenario>` in its title or
description, e.g. `Launch spring sale #approval_edit`.

Scenario steps may carry an optional mock-only `goal:` block (status,
progress, campaign metrics). After the step runs the Hub persists it on the
goal and emits a `goal_updated` event with a `goal_summary` UI, which is what
proba-web's Goals and Campaigns screens render. Creating a goal always emits
an initial `goal_updated`.

## Deployment

### Docker Swarm

Deploy with the provided stack file:

```bash
# Create secrets
echo "your-postgres-password" | docker secret create postgres_password -
echo "your-jwt-secret" | docker secret create jwt_secret -

# Deploy stack
docker stack deploy -c deploy/stack.yml proba

# Check services
docker stack services proba

# View logs
docker service logs -f proba_hub
```

The stack runs 3 replicas of the Hub with shared Postgres and Redis.

### Environment-Specific Configs

- **Development**: Uses `.env` file, verbose logging, hot reload
- **Production**: Uses environment variables, JSON logging, optimized builds

## Protocol Contract

This service implements the transport layer defined in [@smallseedlabs/proba-protocol](https://github.com/smallseedlabs/proba-protocol).

### Open Questions for Protocol v0.1

1. Should `ask` events include a `retryCount` field for clarification loops?
2. Do we need a `cancel_ask` command to dismiss pending asks?
3. Should `goal_updated` events include a diff of what changed?

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

Apache License 2.0 © Small Seed Labs

## Related Projects

- [proba-protocol](https://github.com/smallseedlabs/proba-protocol) - Shared protocol library
- [proba-web](https://github.com/smallseedlabs/proba-web) - Web client UI

---

**Note**: This is a PUBLIC repository. Never commit secrets. Use `.env` for local development and secrets management for production.

**Protocol**: `@smallseedlabs/proba-protocol` is pinned to the `v0.2.0` release tag.
