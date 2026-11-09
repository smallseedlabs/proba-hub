# Analytics and action bot (Hub side)

The Hub schedules and coalesces analytics reviews, stores the gateway evaluator's
reports and dry-run proposals, and executes a proposal **only** when the owner
approves it. Execution goes Hub → gateway (`handle_approval` + `analyticsAction`)
→ Ads domain. Every step is audited.

## Flow

1. **Register** a campaign for review: `POST /v1/analytics/campaigns`
   `{ goalId, probaCampaignId, platform, accountId?, providerCampaignId?, currentDailyBudget?, currency?, rules? }`.
   Each registration covers one provider and account (per-provider isolation). An
   unknown budget is left out. It is never stored as 0.
2. **Review.** You can trigger one manually (`POST .../review`, optional `intent`
   of `report | propose_pause | propose_cap` plus `dailyBudget`), or let the
   scheduler run them. Reviews are coalesced on workspace + user + campaign +
   cadence window + intent: a unique row plus a stable gateway idempotency key.
   When the same window comes round again, the existing review is returned
   (`coalesced: true`).
3. **Intent.** The gateway evaluator does not judge performance. Hub chooses the
   intent from the owner's rules applied to the previous review's metrics:
   - `pauseWhen { minSpend, maxConversions }`
   - `capWhen { minSpend, maxCostPerConversion, proposedDailyBudget }`. This only
     ever lowers a known current budget.

   If any metric is unknown, the result is a report, never an action. For
   scheduled proposals, the rule is checked again against the fresh metrics the
   evaluator returns.
4. **Proposal.** A `dry_run_proposal` is stored as `pending`, together with the
   evaluator's `decisionId`, args, argsHash and review window. A newer proposal
   for the same campaign marks the older one `superseded`. Once the window
   passes, a proposal becomes `expired`.
5. **Decision.** `POST /v1/analytics/proposals/:id/decision`:
   - `reject` audits `approval.rejected` and makes no gateway call.
   - `approve` needs execution state `running` and a proposal that is still
     inside its window. Hub audits `approval.granted` and sends the exact
     proposal to the gateway. The gateway re-checks that the proposal is its
     latest decision, matches the argsHash and scope, applies owner policy and
     mutate preflight, then calls Ads. The proposal ends as `executed` (audited
     `campaign.paused` / `campaign.budget_changed`) or `failed` (audited
     `tool.failed`). A cap update counts as spend-class in the gateway and in
     Ads, so it also needs verified billing there.

## Defaults and limits

- `ANALYTICS_SCHEDULE_ENABLED=false` by default. Scheduling also requires the
  background jobs and the gateway. The scheduler takes the Postgres advisory
  lock `727274008`, so only one Hub instance ticks at a time.
- There is **no delegated or automatic execution**. Every action needs an owner
  approve.
- Only two verbs exist: pause (`ads.pause_campaign`) and budget cap
  (`ads.update_campaign` with a lower `dailyBudget`). **Targeting proposals are
  not implemented**: the Ads update verb has no targeting field, and the
  evaluator has no targeting logic.
- Moving budget between providers is not a proposal type. It stays a separate,
  explicit operation.
- Campaigns are registered by the owner. Automatic registration from a
  create-campaign result is not implemented.

## Approved creative (Reddit post creation)

`PUT /v1/goals/:goalId/creative` takes `{ creative, targeting? }`, where
`creative` is one of:

- `{ type: 'TEXT', headline, body }`
- `{ type: 'IMAGE', headline, body?, mediaUrl, callToAction? }`

`mediaUrl` must be a public https URL that you typed in. There is no default.
The next new command on that goal sends `userSuppliedInput.creative/targeting`
along with your landing URL. The gateway puts these into the `ads.create_campaign`
args, where they are covered by the approval hash, and the model cannot write
them. An approval resume replays the original bound request unchanged.

## Tests

`src/analytics.integration.test.ts` runs against real Postgres with a **FAKE**
gateway (`src/testing/fake-analytics-gateway.ts`): no evaluator, Ads, provider,
model, network or spend. `src/analytics/rules.test.ts` and
`src/analytics/creative.test.ts` are pure unit tests.
