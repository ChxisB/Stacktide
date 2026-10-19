# 17 Secret Scanning - Tasks

### SCAN-1 - Report schema and allowlist parser  `[x]` M - deps: GL-3
Do: read GitLab's secret-detection report schema and example, record the fields in LOG; `parseSecretReport(json)` copies only an allowlist (rule id, path, line, commit, severity, GitLab id/fingerprint), caps size and count, never spreads the input.
Done when: fixtures from the schema parse; a planted secret in every other field (and an unknown one) is absent from the output; malformed and oversized reports fail with a reason, not a throw.

### SCAN-2 - Findings schema and repository  `[x]` M - deps: SCAN-1, API-2
Do: additive migration `secret_findings` (unique `(project_id, fingerprint)`, rule, path, line, commit, severity, status, dismissal reason and actor, first/last seen, composite FK to the project's organization); upsert, list with cursor, resolve-missing.
Done when: db tests - the same finding upserts once; a finding in another project/organization is invisible; resolve-missing only touches the default branch.

### SCAN-3 - Ingest on pipeline finish  `[x]` M - deps: SCAN-2, PIPE-8, GL-3
Do: new `packages/gitlab` method for a job artifact (size-capped, mock + contract); in the PIPE-8 handler, when a finished pipeline has a secret-detection job, fetch the artifact, parse, upsert, resolve missing. Permanent GitLab errors are dropped like PIPE-8's; others retry.
Done when: handler tests - findings stored, rerun idempotent, absent finding resolved, artifact missing is not an error, oversized artifact rejected; canary: no secret in rows, logs or audit.

### SCAN-4 - Findings API, triage and audit  `[x]` M - deps: SCAN-2
Do: list/get routes (project member), dismiss/reopen (project maintainer, reason required, audited); OpenAPI regenerated; `docs/secret-scanning.md` says plainly that a finding must be revoked at the source.
Done when: guard-coverage and authz tests; dismissal without a reason is 422; leak canary on every response.

### SCAN-5 - Opt-in scan job in starter pipelines  `[x]` M - deps: PIPE-3, PIPE-4
Do: a `secretDetection` parameter on the starter templates that includes GitLab's template; `recommend` warns when the project's runners cannot run it.
Done when: render and lint snapshots with and without it; switching it on produces a clean MR; unknown runner capability is a warning, not a failure.

### SCAN-6 - Optional gate  `[x]` S - deps: SCAN-4, POL-3
Do: per-organization setting (off / warn / deny) feeding open default-branch findings into the policy verdict as rule `secret-findings-open`.
Done when: table-driven tests over setting x findings; default is off; deny blocks the existing apply precondition.

### SCAN-7 - CLI and UI  `[x]` M - deps: SCAN-4, UI-7, CLI-6
Do: `orch findings ls|dismiss|reopen`; a findings tab on the project page with the "revoke at the source" notice.
Done when: command and component tests incl. empty and dismissed states; journey test still green.
