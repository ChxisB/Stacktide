# 03 GitLab Integration - Spec
Prefix: GL · Milestone: M1 · Status: todo

## Goal
One typed, rate-limit-aware, testable gateway to GitLab, plus project discovery and webhook intake.

## Scope
Client core; repo/MR, pipeline/lint and variables API methods; mock GitLab; connection management; project import + type detection; webhook receiver.

## Non-goals
Business logic about what to put in a pipeline or which variables to sync (PIPE, SYNC).

## Design
- `packages/gitlab` is the only code that talks to GitLab (invariant 2). Methods return domain types, not raw API JSON.
- Client: base URL + auth strategy (PAT, group/project token, OAuth), keyset pagination where GitLab offers it, retry on 429/5xx honouring `Retry-After`, timeouts, typed errors. Tokens never appear in errors or logs.
- Mock: an in-process `Bun.serve` fake implementing only the endpoints we use, with fixtures. The same contract tests run against the mock by default and against a real sandbox group when `GITLAB_E2E_URL` + token env are set.
- `connections(id, org_id, type, name, config jsonb, secret_enc bytea)` is generic (EXT reuses it); `type='gitlab'` first.
- Webhooks: verify the secret token header in constant time, enqueue a job, answer 200 fast. Dedupe on `X-Gitlab-Event-UUID` / `Idempotency-Key` where present. Events: push, merge_request, pipeline, job, note.
- Project type detection reads the repo tree (package.json, bun.lock, Dockerfile, `*.tf`, `terragrunt.hcl`, ...) and returns tags with confidence.

## Acceptance
Given a PAT, the platform lists projects, imports some with detected types, reads and writes project variables via the client, opens an MR, and processes a signed webhook exactly once - all proven against the mock.

## Risks / human gates
First write to a real GitLab instance is a human gate. GitLab API details (masking rules, hidden variables, lint endpoint, webhook signing) vary by version - confirm against the target instance's docs in GL-1.
