# Research review (Hub forwarding slice)

Hub-only: persist the operator landing URL, forward it on gateway runs, present a
`research_review` ask, and resume `research.accept`. This is **not** spend
approval, live page fetch, Ads create, or a published Hub PR.

Protocol pin (immutable SHA, **no** `v0.6.0` tag):

```
github:smallseedlabs/proba-protocol#298eeb4b4ba3fe14b4bf5077810ce2f433067984
```

Gateway contract: [proba-llm-gateway PR4](https://github.com/smallseedlabs/proba-llm-gateway/pull/4)
at `86630d02cbbeb6b6459676b547c41064d6df3321`. This slice does not modify gateway.

## What Hub does

1. Authenticated `userId` is the session actor. `workspaceId` is the Hub workspace
   (`AUDIT_WORKSPACE_ID` / `seedbed` until Hub models workspaces). Neither is taken
   from `userSuppliedInput` or model/tool fields.
2. `create_goal.payload.userSuppliedInput.landingPageUrl` is persisted on the goal
   (original string). Omitted is valid. There is no default host (including no
   `smallseedlabs.com`).
3. Gateway `POST /v1/runs` gets that **original** `userSuppliedInput` plus
   `goalId` / `threadId`. Changing the URL on the same idempotency key is a
   gateway fingerprint conflict; Hub does not do that.
4. When the snapshot is `awaiting_approval` with `needs[0].verb = research.accept`,
   Hub emits `buildResearchReviewAskEvent` from the gateway artifact (findings,
   assumptions, unknowns, sources). It does **not** call `mapToolCallToEvent`
   for `research.accept` (that mapper emits a system message). Context packets
   are not research.
5. `answer_ask` with `researchAcceptance` must match the displayed pending
   `artifactId` + `version` + `inputRevision`. Mismatch is not acceptance.
   `evaluateResearchReviewAnswer.grantsSpend` is always false.
6. `edit` invalidates the bound artifact on the original run, persists the new
   operator URL (new input revision), and starts a **new** gather run. `approve`
   resumes the bound run with the original URL of that run.

## Fail-closed

- `GATEWAY_URL` default off; enabled with no URL refuses to start; unreachable
  gateway does not fall back to mock/DeepSeek.
- Unconfigured / blocked gateway snapshots are errors, not a fake review.
- Pause/kill still cancel cancellable gateway runs and do not grant approval.

## Tests (no live providers)

Unit tests cover URL extraction, snapshot mapping, and GatewayBrain resume/edit.
Integration tests use real Postgres and a **FAKE** in-process gateway labelled
`FAKE: in-process research gateway` — no network destination crawl, no paid
model, no Ads.

Prior Hub / LLM sanctioned PR publication refusals remain **final**. This
branch is implementation + push only.
