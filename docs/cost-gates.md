# Cost gates

A plan whose **estimated** monthly cost change is above an organization's limit is refused at apply, the way a
policy `deny` is. The platform never prices anything and never holds a pricing key: the plan job's runner
estimates with [Infracost](https://www.infracost.io/docs/) and posts four numbers, and the platform compares them
with the limits an organization admin set. An estimate is not a bill: prices are list prices, and a resource
that is billed by use (requests, bytes, hours) is counted at its base price or at zero.

## Setup

1. **An image for the estimate job.** Set `ORCH_COST_IMAGE` on the worker ([self-host.md](self-host.md)) to an
   image that has `sh`, `jq` and the Infracost CLI **0.10.45 or later of the 0.10 line** (the generated command is
   that CLI's `infracost diff --path <plan.json> --format json`; the 2.x CLI's output was not checked). Without
   the image nothing is estimated.
2. **A pricing key for the runner.** Create an Infracost API key and add it to the GitLab project (or its group)
   as the CI/CD variable `INFRACOST_API_KEY`, **masked**. Only the estimate job's script reads it, but GitLab gives
   a project's variables to every job of its pipelines, so treat it as visible to everything that runs there. It is a
   pricing key and not a cloud credential. Infracost's CLI sends it the resource types and sizes of the plan, not
   the plan itself.
3. **Limits.** An organization admin sets them (`PUT /organizations/:orgId/cost-limits`, action `cost.limit.set`;
   `GET` lists, for any member, `DELETE /:limitId` removes, for an admin):

   ```sh
   curl --request PUT "$ORCH_API_URL/organizations/$ORG_ID/cost-limits" \
     --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" \
     --data '{"tag": "prod", "maxMonthlyDelta": 100, "warnAt": 80, "currency": "USD"}'
   ```

   - `maxMonthlyDelta` is what **one plan** may add to the monthly cost, in `currency`; a delta equal to it is
     allowed, zero allows no increase. `warnAt` (optional, not above the maximum) warns from that delta on.
   - Leave `tag` out for the organization's own limit, which reaches every stack no tagged limit reaches. At most one
     limit per scope and 100 per organization; the same scope again replaces the limit.
   - Which stacks a tagged limit reaches is the `tags` of the stack's `stack.yml`.
4. A limit that no stack's tag reaches, and an organization with no limit at all, change nothing: **no limit means
   no estimate job and no check**, and every stack applies as before.

## What the plan job does

For each stack a limit reaches, the generated pipeline gets an `estimate:<stack>` job in a stage of its own
between the plans and the summaries. It runs the cost image, needs the stack's `plan.json`, may fail without
failing the pipeline (`allow_failure`), and holds neither the platform's token nor any cloud credential. Its script
is one line (shown for a stack `db` in `stacks/db`):

```sh
{ [ -n "$INFRACOST_API_KEY" ] && infracost diff --path stacks/db/plan.json --format json > infracost.json && jq -e -c --arg tool infracost 'def amount: (if type == "string" then tonumber else . end) | select(type == "number" and . >= -1e12 and . <= 1e12); (.currency | select(type == "string" and test("^[A-Z]{3}$"))) as $currency | (.totalMonthlyCost | amount | select(. >= 0)) as $total | (.diffTotalMonthlyCost | amount) as $delta | {monthlyDelta: $delta, monthlyTotal: $total, currency: $currency, tool: $tool}' infracost.json > cost.json; } || rm -f cost.json
```

It writes `cost.json` only when there is a key, Infracost succeeded, and the answer has a currency code and
numbers in range; otherwise it removes `cost.json` and ends well. The stack's summary job then adds the estimate
to the counts it posts, when there is one:

```sh
if [ -s cost.json ] && jq -c --slurpfile cost cost.json '. + {cost: $cost[0]}' summary.json > summary.merged; then mv summary.merged summary.json; fi
```

The platform stores the delta, the total, the currency and the tool name with the stack's plan (see
`POST /runs/:runId/plan-summary` in `openapi.json`).

## What it decides

For a stack a limit reaches, at apply (the limits in force **then**, not when the plan was made):

| The plan's estimate | Verdict | Rule |
|---|---|---|
| delta below `warnAt` (or at or under the maximum, with no `warnAt`) | pass | |
| delta from `warnAt` up to and including the maximum | warn: the apply goes ahead | `cost-near-limit` |
| delta above the maximum | deny | `cost-over-limit` |
| a currency that is not the limit's | deny: never converted | `cost-currency-mismatch` |
| no estimate (no image, no key, Infracost failed, or it priced nothing) | deny | `cost-unavailable` |

A DNS zone (`tool: dnscontrol`) is never judged by a limit: its plan is record changes with no price, so it has no
estimate and is not `cost-unavailable`. Its stack is left out of the estimate jobs, the *Cost (estimate)* section and the
"cannot be applied" note.

A deny refuses the apply with 409 `cost_denied`, naming the stack and the rules, after the policy checks
(`policy_denied` comes first). A stack with several tags that each have a limit takes the **strictest** (the lowest
maximum, ties by tag name); the organization's own limit applies only when none of its tags has one.

The merge request note has a *Cost (estimate)* section with a line per stack: the delta, the total, the tool,
the limit and what it makes of the estimate, always as an "estimate". `GET /organizations/:orgId/projects/:projectId/runs`
(and `/:runId`) give each stack a `cost` object with the same. The note is rewritten when a run event arrives, not
when a limit changes, so it can show the limits as they were; the API shows them as they are.

## What to know

- **A merge request can drop a tag.** Removing a tag from `stack.yml` in the same merge request removes that tag's
  limit for the branch's plan and apply, and the stack falls back to the organization's own limit, or to none.
  Only an org admin can set a limit; nothing makes them review `stack.yml`. Review it like code that runs.
- **The limit that is shown is the limit of the tags the run kept.** A merge request's plan keeps the tags its
  commit has, which are the ones the apply reads (a commit does not change). A run started through `POST /runs`
  keeps the tags the project's registered stacks have, and its apply reads the commit's, so the two can differ.
  Limits are read when the note is written or the run is read, and again at apply; an applied stack shows what the
  limits say now, so a lowered limit makes an old run read "deny".
- **A limit with no estimate denies.** That is deliberate (nothing judged is not a pass) and it means a missing
  `ORCH_COST_IMAGE` or `INFRACOST_API_KEY` blocks the apply of every stack a limit reaches. Remove the limit to opt
  out. When the worker has no image, the merge request note says so and names the stacks; a missing key shows only
  as "no estimate". A stack whose plan has no summary yet (its estimate may still be running) is refused as
  `cost-unavailable` too: apply again when the summary job is done.
- **Retry a stack's jobs together.** The summary job merges the `cost.json` it finds. If you retry only a stack's
  `plan:` job and then its summary, the estimate of the older plan is merged. Retry `plan:`, `estimate:` and
  `summary:`, or push a new commit.
- **Who sees the limits.** The run API puts the limit that reaches a stack in that stack's `cost`, so anyone who may
  read the project's runs sees it, though `GET …/cost-limits` needs an organization role.
- **One currency per limit.** `maxMonthlyDelta` is in the limit's currency and the estimate must be in it; set a
  limit per tag if teams price in different currencies.
- **Not verified against a real Infracost.** The generated command and the fields it reads (`currency`,
  `totalMonthlyCost`, `diffTotalMonthlyCost`) follow the 0.10 CLI's documentation. The first real estimate is yours
  to check: run a plan with a small limit and read the note. The tests use hand-written outputs
  (`apps/api/src/fixtures/cost/`: small, warn, deny and one that priced nothing) and a fake `infracost`.
- **GitLab and `allow_failure`.** The summary job needs the estimate job so that it gets `cost.json`. GitLab runs a job
  whose needed job failed with `allow_failure`; this was not tried against a real GitLab.
