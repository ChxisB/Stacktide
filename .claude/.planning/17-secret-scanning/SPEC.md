# 17 Secret Scanning - Spec
Prefix: SCAN · Milestone: M5 · Status: todo (planned 2026-10-19, awaiting approval)

## Goal
Know when a secret has been committed to a managed project, triage it, and gate on it - without the platform ever storing or showing the secret.

## Scope
Ingest GitLab's secret-detection report; findings store and lifecycle; API/CLI/UI; an opt-in scan job in the starter pipelines; an optional gate.

## Non-goals
Writing our own scanner or rule set. Scanning git history beyond what GitLab's analyzer reports. Matching findings against the values the platform manages (needs repository content in the control plane; revisit after v1). Auto-rotation on a finding (a link to ROT is a follow-up).

## Design
- **Reference** (Infisical "secret scanning"): detect leaked secrets, track them. **Reuse over build:** GitLab's `secret_detection` job runs in any tier and produces `gl-secret-detection-report.json` as a downloadable job artifact (docs read 2026-10-19); only MR widgets and the vulnerability report need Ultimate. We ingest the artifact and keep our own triage.
- **Where it runs:** the scan runs in the project's pipeline (runner side). The platform reads the finished job's artifact through `packages/gitlab` when the existing pipeline event handler (PIPE-8) sees the pipeline finish. No repository file is fetched by the control plane.
- **Never store the secret.** I could not confirm from the docs whether a finding carries a raw source extract. SCAN-1 reads GitLab's report schema first, and the parser is an **allowlist**: it copies only rule id, file path, line, commit, severity and GitLab's finding id/fingerprint; it never spreads the object. A canary test proves a planted secret in any unlisted field is dropped.
- **Findings:** unique per `(project, fingerprint)`; status `open | dismissed | resolved`; dismissal needs a reason and is audited; a finding absent from the next default-branch report is marked `resolved`.
- **Gate (optional):** an organization setting that makes open findings on the default branch a `warn` or `deny` in the policy verdict path (POL-3 `judge()`), default off.
- **Starter pipelines:** an opt-in `secret-detection` job (GitLab's template) in the PIPE templates; the runner needs the docker/kubernetes executor and a `test` stage (docs), which `recommend` must check or warn about.

## Acceptance
A fixture pipeline with a planted fake key produces one open finding with path and line and no secret anywhere (row, response, audit, log, MR note); a dismissal needs a reason and appears in the audit log; the next clean report resolves it.

## Risks / human gates
First read of a real artifact and the first real finding are human gates. A leaked secret is only *found* here: the user must still revoke and rotate it at the source, and the UI says so.

## Open questions
1. Is requiring a docker/kubernetes executor acceptable, or do some of your runners (shell executor) need another route?
2. Gate default: warn or deny, once the org turns it on?
