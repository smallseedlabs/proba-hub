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
- `AUDIT_ENABLED` (default `true`), `AUDIT_RELAY_ENABLED` (default `true`, `false` under `NODE_ENV=test`), `AUDIT_STREAM` (default `proba.audit.events`), `AUDIT_WORKSPACE_ID` (default `seedbed`), `AUDIT_CONTENT_ENABLED` (default `false`: raw message/reply text on audit events, secrets masked): see [Audit trail](#audit-trail)

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
  "workspaces": [{ "id": "seedbed", "name": "Seedbed" }],
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

Workspaces are not modelled yet; every user gets one `seedbed` workspace ("Seedbed"; it was `default` / "My workspace" before). There is no workspace table or column, so no data migration is needed.

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

## Audit trail

The Hub emits a protocol v0.3.1 `AuditEvent` (`@smallseedlabs/proba-protocol/audit`) for every
action, through a transactional outbox, to the audit pipeline of
[proba-audit](https://github.com/smallseedlabs/proba-audit):

```
Hub action ──same DB transaction──> audit_outbox ──AuditRelay──> Redis Stream ──audit-consumer──> ClickHouse
```

- **Same transaction.** Events are inserted into `audit_outbox` (migration `004_audit_outbox`) with the
  business change (`emit(draft, { tx: client })`), so an event exists if and only if the change
  committed. Events with no business change (denied sign-in, SSE connect) are single-statement
  transactions. If the database refuses the insert the action fails and rolls back (fail closed); an
  event that fails protocol validation is logged at error level and dropped (fail open).
- **Relay.** `AuditRelay` is a separate background loop (`AUDIT_RELAY_ENABLED`) that claims rows with
  `FOR UPDATE SKIP LOCKED`, publishes them to `AUDIT_STREAM` (same entry format as proba-audit's Redis
  adapter) with the Hub's existing Redis client, and marks them published. Delivery is at-least-once;
  the consumer dedupes by `eventId`. It does not touch the SSE relay or the `proba:events` pub/sub channel.
  With `AUDIT_RELAY_ENABLED=false` events keep accumulating in `audit_outbox` until a relay runs.
- **Vendored code.** The emitter, outbox store, relay and stream publisher are copies of proba-audit
  `038d63f` under `src/audit/vendor/proba-audit/` (see its README) behind the same `AuditEmitter` /
  `OutboxStore` interfaces, so they can be swapped for published packages later.
- **One traceId per request.** For `POST /v1/commands` the traceId is the command's `clientMsgId` (a UUID
  in the protocol). Otherwise (other routes, or a `clientMsgId` that is not a UUID: the id is then
  recorded in `details.clientMsgId`) a UUID is generated; background jobs get a fresh id per run. The
  traceId flows through `AsyncLocalStorage` to the handler, command processor, brain call and DB writes,
  is on every log line (`traceId`), and is returned as `X-Trace-Id` (exposed via CORS). Spans are
  OpenTelemetry style: the request's first event is the root span; the brain call is a child span and
  its plan/tool/decision events are children of it. The event envelope itself has no trace field, so
  the protocol is unchanged and the traceId is not added to SSE events.
- **No secrets, no PII.** `details` pass through a redactor (`src/audit/redact.ts`): secret-named keys,
  personal keys (email, phone, ip, ...), bearer tokens, JWTs and email-shaped strings are removed or
  masked and size is bounded. Callers record ids and sizes in `details`, never message text, brain output text, tool
  parameter values, tokens or addresses.
- **Raw text, opt-in (`AUDIT_CONTENT_ENABLED`, default `false`).** When on, four events also carry the
  text itself in the protocol's `content` field (protocol 0.3.3): `thread.message_received` (`user_message`),
  `brain.reply_generated` (`brain_reply`), `brain.explanation_generated` (`explanation`) and
  `brain.clarification_requested` (`brain_clarification`: the reason and the numbered questions). It is written in the same
  transaction and outbox row as the event; `details.textLength` stays. The text goes through
  `maskSecretsInText` (`src/audit/redact.ts`), a "secrets only" mode: passwords, tokens (bearer, JWT, labelled, query
  parameters), API keys (Stripe/OpenAI-style, GitHub, Slack, Google, AWS prefixes), private key blocks and Luhn-valid card
  numbers are replaced with `[REDACTED...]` and counted in `content.redactions`; names, emails, numbers and plans stay as
  written. Text over 16 384 characters is truncated and flagged (`truncated`, `originalLength`). A word that merely looks
  like a secret may be masked (better than keeping a real one). Turn it on only where the audit store's access rules
  (proba-audit: admin role only) fit the conversation's sensitivity.

### Events emitted

Every action is a **specific** name from the protocol v0.3.1 catalog (`AUDIT_ACTION_INFO`). The
`category` field and the default `riskLevel` come from that catalog, not from the action prefix
(`goal.created` is `data_access`, `control.paused` is `config`); a producer only overrides the risk when
the data carries one (a tool's own risk, a brain decision). The generic and alias names
(`data_access.read|write`, `policy.evaluated|denied`, `config.changed`, `tool.called`,
`brain.clarify_requested`, ...) are never emitted: `HubAudit.emit` refuses them and a unit test
(`src/audit/emitted-actions.test.ts`) fails if the code mentions one.

| Action | Category (default risk) | When |
| --- | --- | --- |
| `auth.sign_in` | auth | Firebase sign-in succeeded (`/v1/auth/session`), or `/dev/login` |
| `auth.session_issued` | auth | Session row created (child of `auth.sign_in`) |
| `auth.sign_out` | auth | `POST /v1/auth/logout` |
| `auth.session_revoked` | auth | Session row deleted (child of `auth.sign_out`) |
| `auth.denied` | auth | Invalid Firebase token (`failure`), user not allowed / rate limited (`denied`), missing or invalid bearer token (`denied`, throttled to one per client and reason per minute) |
| `command.received` | command | Root event of every `POST /v1/commands` |
| `command.accepted` | command | Command passed validation (202 accepted); same transaction as thread creation |
| `command.rejected` | command | Envelope/payload validation failed (`failure`) or thread not owned (`denied`) |
| `command.processed` | command | Processing finished (`success`) or failed (`failure`, also when the processing transaction rolled back) |
| `command.duplicate` | command | Same `clientMsgId` replayed (idempotent) |
| `thread.created` | command (low) | A thread row was created for a command (`details.boundToCommand`) |
| `thread.message_received` | command (low) | A `send_message` command added the user's message to a thread (`details.textLength`, never the text) |
| `thread.access_denied` | policy (medium) | The command named a thread the user does not own (`denied`, `details.policy: thread_ownership`) |
| `brain.llm_call` | brain (low) | Brain invoked (the invocation only); details hold output types and sizes (never text) |
| `brain.reply_generated` | brain (low) | The brain replied (`details.textLength`) |
| `brain.explanation_generated` | brain (low) | The brain explained something (`details.textLength`) |
| `brain.clarification_requested` | brain (low) | The brain asked clarifying questions |
| `brain.plan_created` / `brain.decision_made` | brain (low / medium) | Brain output of that kind (child of the brain span; a decision carries `low` / `medium` / `high` for keep / change / kill) |
| `brain.error` | brain (medium) | Brain threw, or returned an invalid output / one that could not be stored |
| `tool.proposed` | tool (low) | Brain proposed a tool call; it has not run (`partial` while it needs approval; the Hub executes no tools; parameter names only; risk is the tool's own) |
| `budget.evaluated` | policy (medium) | A proposed tool call's cost impact (`details.enforced: false`, `limit: null`, `spent`, `proposed`; the decision is the brain's) |
| `goal.created` | data_access (low) | `create_goal` stored a goal |
| `goal.updated` | data_access (low) | The brain updated a goal (`details.changedFields`: names, not values) |
| `goal.status_changed` | data_access (low) | The goal status moved (`details.from`, `details.to`; child of `goal.updated`) |
| `goal.clarification_answered` | data_access (low) | The user answered a clarification ask |
| `goal.budget_proposed` | policy (medium) | The goal was created with a budget (`details.proposedBy: user`, `enforced: false`) |
| `goal.budget_approved` / `goal.budget_declined` | approval (medium / low) | The user approved / declined an approval ask that carried a cost effect (next to `approval.granted` / `approval.rejected`, which is its parent) |
| `approval.requested` | approval (low) | Plan or tool call waiting for approval |
| `approval.granted` / `approval.rejected` | approval (medium / low) | `approve_plan`, or `answer_ask` on a plan/action approval |
| `approval.expired` | approval (low) | Ask expired (job run) |
| `control.paused` / `control.resumed` | config (medium) | `control` command `pause` / `resume` (`details.scope`: `thread` or `workspace`) |
| `control.emergency_stopped` | config (high) | `control` command `kill` (tag `emergency_stop`); the Hub's kill stops everything in scope, so it is not `control.killed` (reserved for one goal or run) |
| `stream.connected` / `stream.disconnected` | data_access (low) | SSE stream opened / closed (`details.transport: sse`, resume position or last seq, duration; no address) |
| `system.started` / `system.stopped` | system | Hub boot / shutdown |
| `system.job_run` | system | Ask-expiry run that expired something (its own traceId) |
| `system.error` | system (medium) | Unhandled 5xx, command processing failure, ask-expiry job failure |

Reads (polling `GET /v1/events?after=`, `/v1/threads`, ...) are not audited.

Known limits: the Hub has no budget enforcement, so budget events are informational; pause/resume/kill
only emit a `status` event (the mock brain does not really stop); `auth.denied` throttling is per replica.

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

The stack runs 3 replicas of the Hub with shared Postgres and Redis, plus a one-shot `migrate` job
(`replicated-job`, Docker 20.10+) that applies pending migrations with the compiled entry point
(`node dist/db/migrate-cli.js`). Concurrent runners are serialized by a Postgres advisory lock.

**Known limits with several replicas (not fixed here):**

- The mock brain keeps its scenario step counter (`threadStates`) in process memory. A thread's steps
  only advance correctly when all its commands reach the same replica, which three replicas behind
  a round-robin ingress do not guarantee. The real brain is expected to be stateless.
- The session-exchange rate limiter (`FixedWindowRateLimiter`) and the `auth.denied` audit throttle are
  per replica, so the effective limits are multiplied by the replica count.
- Every replica runs an audit relay by default. That is safe (rows are claimed with `SKIP LOCKED`) but
  stream order between batches of different replicas is not strictly the outbox order. Set
  `AUDIT_RELAY_ENABLED=false` on all but one replica if strict order matters to the consumer.

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

**Protocol**: `@smallseedlabs/proba-protocol` is pinned to the `v0.3.1` release tag.
