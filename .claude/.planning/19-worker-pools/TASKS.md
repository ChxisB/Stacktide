# 19 Worker Pools - Tasks

### POOL-1 - Pool model and API  `[x]` M - deps: API-2, AUTH-3
Do: additive migration `worker_pools` (organization, unique name, tags[1..10], optional image, enabled, `is_default`; at most one default per organization); org-admin CRUD; every mutation audited; tag and image validation (charset, no variables).
Done when: guard-coverage and authz tests; invalid tags/images are 422; two defaults are refused; OpenAPI regenerated.

### POOL-2 - Attach a pool to stacks  `[x]` S - deps: POOL-1, IAC-1
Do: `pool` key in `stack.yml` (schema + scan), resolved against the organization's pools with the default as fallback; the stack record carries the resolved name.
Done when: scan tests - named pool, default, none, unknown name (reported on the stack, not a crash).

### POOL-3 - Generated pipelines target the pool  `[x]` M - deps: POOL-2, IAC-4
Do: `pipeline-gen` adds `tags:` (and `image:` when set) to a stack's plan, apply and drift jobs; an unknown or disabled pool fails generation with a named error - never a silent fallback to shared runners.
Done when: snapshots with and without a pool, with image override, and for the failure; a stack with no pool is byte-for-byte unchanged.

### POOL-4 - Pool health from GitLab  `[x]` M - deps: POOL-1, GL-5
Do: `packages/gitlab` method to list project runners with tags/online state (mock + contract); `GET /pools/:id/status` returns online count per tag set, or `unknown` when the token lacks permission.
Done when: mock tests for online, none online, no permission (`unknown`, not `healthy`); no runner tokens or addresses in the response.

### POOL-5 - CLI and settings UI  `[x]` M - deps: POOL-1, POOL-4, UI-8
Do: `orch pool ls|add|rm|default`; a pools section in settings with status; docs including the "tags are routing, not isolation" warning.
Done when: command and component tests for empty, healthy, unknown and unattached states; journey test still green.

### POOL-6 - Tag the policy/cost/drift steps  `[x]` S - deps: POOL-3, POL-3
Do: confirm every step of the plan job (policy evaluator, later the cost step) inherits the stack's tags; add a structural test that every job in the generated child pipeline carries the pool tags.
Done when: the structural test fails if a job is added without them.

### POOL-7 - ADR: a platform-shipped pull-based agent  `[x]` S - deps: POOL-3
Do: write the ADR comparing (a) runner tags only (what is built), (b) an agent that polls the platform for runs (outbound HTTPS, token + certificate, one run per worker, as in Spacelift's pools), and what (b) would change in D1 and invariant 3. **Human gate; no code.**
Done when: you decide; if (b) is chosen it is planned as a new feature.
