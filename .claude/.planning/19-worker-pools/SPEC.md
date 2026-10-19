# 19 Worker Pools - Spec
Prefix: POOL · Milestone: M5 · Status: todo (planned 2026-10-19, awaiting approval)

## Goal
Let an organization run its IaC, drift, policy and cost jobs on its own runners, chosen per stack, with the platform still holding no cloud credentials.

## Scope
A named pool = GitLab runner tags (+ optional image) per organization; attaching a pool to stacks; the generated pipelines targeting it; a read-only health view; an ADR on a real pull-based agent.

## Non-goals
A platform-run worker fleet or a pull-based agent in this feature (POOL-7 only decides it). Provisioning or autoscaling runners. Managing runner registration tokens.

## Design
- **D1 already says GitLab CI is the runner**, so your own runners *are* your own worker pools; the missing piece is choosing them. Pools are therefore tags: the generated child pipeline puts `tags: [...]` on a stack's jobs (and `image:` when the pool sets one).
- **Reference** (Spacelift worker pools, docs read 2026-10-19): workers are pull-based - outbound HTTPS only, authenticated with a pool token plus a certificate from a CSR, one run at a time per worker, a pool must be attached to each stack before it takes work, and run state is encrypted so only the pool reads it. GitLab runners already match the outbound-only, pull-based and attach-per-workload parts; the encrypted-run-state and token/CSR part would only matter for an agent we run ourselves (POOL-7).
- **Fail closed:** a stack naming an unknown or disabled pool does not fall back to shared runners; generation fails with a named error, because a prod stack silently running on a shared runner is the failure this feature exists to prevent.
- **Attachment:** `stack.yml` `pool: <name>`, with an organization default pool for stacks that name none; no default means today's behaviour.
- **Health:** read-only, through `packages/gitlab`: online runner count for the pool's tags (needs a token that can list project runners; if it cannot, the view says "unknown", never "healthy").
- **Where the tags apply:** the IaC plan/apply/drift jobs, and the policy and cost steps (COST-4) that live in the plan job. PIPE starter templates are project-owned and untouched.

## Acceptance
A stack with `pool: prod-runners` yields child-pipeline jobs tagged with that pool's tags and nothing else changes; an unknown pool refuses generation; the health view shows online counts from the mock and "unknown" without permission.

## Risks / human gates
- POOL-7 (agent ADR) is a human gate and may change D1/invariant 3. First real pipeline on a real tagged runner is a human gate.
- Tags are a routing hint, not isolation: anyone who can register a runner with the tag receives the job. The doc states this.

## Open questions
1. Is "your own runners via tags" the meaning of "own worker pools", or do you want an agent the platform ships (POOL-7)?
2. Should a pool restrict which projects/stacks may use it (an allowlist), or is org-wide enough for v1?
