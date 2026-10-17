# 03 gitlab-integration: done (2026-10-17)

All 8 tasks `[x]`. Gate: `bun run check` green, 737 pass + 1 skip (the opt-in real-instance contract run) + 0 fail, 53 files. One local commit per task, nothing pushed.

| Task | Commit | What |
|---|---|---|
| GL-1 | e047247 | GitLab client core: auth strategies, keyset pagination, retries honouring `Retry-After`, timeouts, typed errors, token redaction |
| GL-2 | beaa9ef | Project, repository and merge request methods, plus the in-process mock GitLab and contract suite |
| GL-3 | 20e1c7b | Pipelines, jobs and CI lint; trigger variables never echoed |
| GL-4 | df15bd9 | Project and group CI variable methods; `canMask`; exact-scope writes |
| GL-5 | f58bf0a | Mock failure injection, branch cleanup, opt-in real-instance contract (`GITLAB_E2E_URL`), **not run** |
| GL-6 | 464fffd | Connections: per-connection DEK, sealed token, `openConnection` as the only way back to plaintext, test-before-store |
| GL-7 | 1d196dc | Discovery and import with path-based type detection (`bun`, `node`, `docker`, `terraform`, `terragrunt`) |
| GL-8 | 491e15d | Webhook receiver: hashed per-connection secret shown once, constant-time check before the body is read, one job per delivery id, closed list of payload fields |

Details, mutation results and review outcomes per task are in `03-gitlab-integration/LOG.md`.

## Decisions to review (REVIEW-tagged in the LOG)

- **Crypto / key handling (GL-6)**: one DEK per connection wrapped by the current master key (`ORCH_MASTER_KEYS`, newest first) with context `connection:<id>`; AAD binds the ciphertext to organization and row. Master keys live in the process environment, there is no key wiping, and no job yet replaces DEKs after a master-key rotation (per-connection DEKs need rewrap coverage). Losing every master key loses every connection secret, so OPS-4 (backup) must cover it.
- **Delete semantics**: organization -> connections is RESTRICT (an org with connections cannot be deleted, 409); connection -> `webhook_deliveries` is CASCADE (jobs stay); `webhook_deliveries.job_id` is SET NULL.
- **Webhook secret (GL-8)**: only the SHA-256 is stored, the secret is shown once, issuing again replaces it at once (no overlap). Unknown connection, no secret, wrong type and wrong token all answer the same 401.
- **Webhook payload**: a fixed list of fields per event, never the body (pipeline hooks carry CI variables, notes carry free text). Consumers must treat it as a hint and re-read state from GitLab.

## Remaining risks and open follow-ups

- **Mock fidelity**: everything above is proven against the mock GitLab only. The GL-5 real contract run was never executed; OAuth, members, JWKS, token-info, project listing with `id_after`, hidden-variable behaviour and webhook header and payload shapes are unverified against a real instance.
- **First write to a real GitLab is a human gate** and has not happened. The default-branch guard in the client needs GitLab-side branch protection to be a real guarantee.
- **GL-6 SSRF caveat**: in production only literal loopback hosts are refused; DNS names, private ranges and metadata addresses are open, and failure messages work as a port probe. No token update or rotation endpoint (delete and recreate), admin-only read, create needs GitLab reachable, no per-org rate limit.
- **GL-7**: tree scan capped at 5000 entries below the top level (reported as `truncated`, not stored); detection is path-based; which connection serves a project is not recorded and `gitlab_project_id` is unique per org, so two GitLab instances in one org collide; renames and moves are not followed; up to ~52 GitLab calls per large repo with no rate limit.
- **GL-8**: no rate limit on the public receiver; `webhook_deliveries` has no retention job; nothing consumes `gitlab.event` until PIPE / IAC-6; no dedupe without an `Idempotency-Key` or `X-Gitlab-Event-UUID`; an invalid delivery id or a missing project id is a 400, which GitLab counts as a failed delivery.
- **GL-4**: the exact-scope variable pre-check is racy and costs an extra GET.
- `/security-review` could not run (no remote); inline reviews are recorded per task.
- Migrations `0009`, `0010` and `0011` need `bun run db:migrate` on the local dev database.
