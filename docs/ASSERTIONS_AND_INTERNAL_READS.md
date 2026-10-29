# Act-as assertions and internal reads

The context bridge builds brain context by reading Hub task state and conversation
on behalf of one user at a time. The Hub mints short-lived **act-as assertions**
for that user and exposes **internal read routes** that accept only the bridge's
`context-reader` service identity plus a matching assertion.

Contract fixtures live in [`contracts/context-reader/`](contracts/context-reader/).

## Act-as assertion (minted by the Hub)

| Field | Value |
|-------|-------|
| Algorithm | EdDSA (Ed25519) |
| Header | `alg=EdDSA`, `kid`, `typ=JWT` |
| `iss` | `proba-hub` |
| `aud` | `["proba-context","proba-audit","proba-memory","proba-hub"]` |
| `sub` | acting user id |
| Claims | `workspaceId`, `goalId`, `threadId`, `scopes`, `iat`, `exp`, `jti` |
| Lifetime | `exp − iat` ≤ 5 minutes |

Private key: `HUB_ASSERTION_PRIVATE_KEY_FILE` (PKCS#8 PEM) with `HUB_ASSERTION_KEY_ID`.
Public JWKS (rotation set): `HUB_ASSERTION_PUBLIC_KEY_FILE`, also served at
`GET /v1/.well-known/assertion-keys` (public, cacheable, no secrets).

When `NODE_ENV=production` and `CONTEXT_BRIDGE_URL` is set, the Hub refuses to start
without `HUB_ASSERTION_PRIVATE_KEY_FILE`. Production also refuses a key under a
temporary directory and a private key file readable by group or others.

### Local key generation

```bash
node scripts/generate-assertion-keypair.mjs --kid hub-key-1 --out ./keys
# Also generate a separate pair for the bridge's service token:
node scripts/generate-assertion-keypair.mjs --kid bridge-key-1 --out ./keys
```

Set on the Hub:

- `HUB_ASSERTION_PRIVATE_KEY_FILE=./keys/hub-key-1.private.pem`
- `HUB_ASSERTION_KEY_ID=hub-key-1`
- `HUB_ASSERTION_PUBLIC_KEY_FILE=./keys/hub-key-1.jwks.json` (optional; derived from the private key when omitted)
- `CONTEXT_SERVICE_PUBLIC_KEY_FILE=./keys/bridge-key-1.jwks.json`
- `HUB_CONTEXT_READER_ENABLED=true`

Never commit `*.private.pem`.

## Context-reader calls

| Part | Value |
|------|-------|
| `Authorization: Bearer <service token>` | EdDSA JWT: `iss=proba-context`, `aud=proba-hub`, `sub=context-reader`, `jti`, `exp` ≤ 2 minutes after `iat` |
| `X-Act-As: <assertion>` | Hub act-as JWT above |
| Scope | `actorId` + `workspaceId` + `goalId` must equal the assertion's `sub`, `workspaceId`, `goalId` (query on GET; body `userId`/`workspaceId`/`goalId` on authorize) |

| Case | Answer |
|------|--------|
| Service token missing or invalid | `401` |
| `X-Act-As` missing | `400` `act_as_required` |
| Scope params missing | `400` `act_as_scope_required` |
| Assertion expired / wrong audience | `403` `act_as_expired` / `act_as_invalid` |
| Scope differs from assertion | `403` `act_as_mismatch` |

The role is accepted **only** on:

- `GET /v1/internal/goals/{goalId}/state`
- `GET /v1/internal/threads/{threadId}/messages?cursor=&limit=`
- `POST /v1/internal/authorize`

A context-reader token on a public route is refused (`401`). A user session on an
internal route is refused (`401`).

## What each route returns

- **Goal state**: goal, status, step, budget (current and proposed), approvals and
  declines, campaign ids from goal metrics when present. Only if the goal belongs
  to the assertion's user in the default workspace (`seedbed`).
- **Messages**: newest first, cursor pagination, secret/PII masking applied to text.
  Only the user's own thread for the assertion's goal.
- **Authorize**: `{ allowed, reason }` — user exists, workspace is allowed, user owns the goal.

## Audit

Every successful internal read is recorded as `context.source_fetched` with actor
`service:context-reader` and details `caller`, `assertionJti`, `tokenJti`, `operation`
and counts — never message text. Refusals are `auth.denied`.

## ContextClient (wired into every brain step)

`src/brain/context-client.ts` defines the port; `HttpContextClient` calls
`POST {CONTEXT_BRIDGE_URL}/v1/context/build` with timeouts and a circuit breaker.
The command processor mints an act-as assertion, attaches the packet
(`brain.context_attached`), and runs an optional hybrid needs loop. See
[Brain ↔ context bridge](BRAIN_CONTEXT_BRIDGE.md).
