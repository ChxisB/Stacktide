# 03 GitLab Integration - Tasks

### GL-1 - Client core  `[x]` M - deps: FND-4
Do: `packages/gitlab` fetch wrapper: auth strategies, keyset/offset pagination iterator, retry with `Retry-After`, timeouts, typed errors, token redaction. Check the target GitLab version's API notes.
Done when: tests (local fake server) cover pagination, 429 backoff, 5xx retry limit, timeout and that no token appears in any error string.

### GL-2 - Projects, repository and MR methods  `[ ]` M - deps: GL-1
Do: list/get projects and groups; repository tree (recursive, keyset); get file; compare refs; create branch; commit files (commits API with actions); create/get/update MR; MR notes (create/update).
Done when: each method has a contract test (shared with GL-5 mock).

### GL-3 - Pipelines and CI lint methods  `[ ]` S - deps: GL-1
Do: trigger pipeline (with variables), get pipeline/jobs, retry/cancel; project CI lint (content, dry-run).
Done when: contract tests pass, including lint error mapping to a typed result.

### GL-4 - Variables methods  `[ ]` M - deps: GL-1
Do: project and group variables list/create/update/delete with `environment_scope`, `masked`, `protected`, `raw`, `variable_type`; a pure `canMask(value)` helper for GitLab's masking rules.
Done when: contract tests cover scope-qualified update/delete and `canMask` table tests (length, charset).

### GL-5 - Mock GitLab and contract suite  `[ ]` M - deps: GL-2, GL-3, GL-4
Do: In-process fake implementing the endpoints above with fixtures and failure injection (429/500); contract tests run against the mock by default and the real sandbox when env is set.
Done when: the whole suite is green against the mock; the real-instance run is documented and opt-in. **First real-instance write is a human gate.**

### GL-6 - Connections  `[ ]` M - deps: VAR-1, API-2, GL-1
Do: generic `connections` table; create/test/list/delete for `type='gitlab'`; secret stored via `packages/crypto`; connection test calls `/user` and reports scopes.
Done when: tests prove the token is encrypted at rest, never returned by any endpoint, and a bad token yields a clear error.

### GL-7 - Project import and type detection  `[ ]` M - deps: GL-2, GL-6
Do: discover projects the connection can see; import selected ones into `projects`; detect type tags from the repo tree; store them.
Done when: fixture trees for Bun, Node, Docker, Terraform and mixed repos produce the expected tags; re-import is idempotent.

### GL-8 - Webhook receiver  `[ ]` M - deps: GL-6, API-6
Do: `POST /webhooks/gitlab/:connectionId`; constant-time secret check; dedupe by delivery id; enqueue a job per event; ignore unknown events.
Done when: tests cover bad/missing secret (401), duplicate delivery (processed once), unknown event (accepted, ignored) and handler failure retry.
