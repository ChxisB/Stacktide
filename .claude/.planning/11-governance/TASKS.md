# 11 Governance - Tasks

### GOV-1 - Audit query, export, retention  `[x]` M - deps: API-8, AUTH-3
Do: filtered, cursor-paginated audit API; JSON/CSV export (audited); retention setting with a safe purge job.
Done when: tests cover filters, permission checks, export content free of values, and purge respecting retention only.

### GOV-2 - Protected environments and change requests  `[x]` M - deps: VAR-4, GOV-1
Do: `environments.protected`; variable writes on protected envs create a change request; approve/reject endpoints; author cannot approve own request; expiry.
Done when: tests cover the full state machine, self-approval rejection, expiry and that pending values are encrypted.

### GOV-3 - Approvals for sync and IaC apply  `[x]` M - deps: GOV-2, SYNC-6, IAC-8
Do: protected-environment sync apply and IaC apply require an approved change request; auto-sync stays manual there.
Done when: tests show apply is rejected without approval and succeeds with it for both paths.

### GOV-4 - Audit forwarding  `[x]` M - deps: GOV-1, POL-2
Do: configurable sinks (webhook, syslog, Datadog/Splunk HTTP collectors) with at-least-once delivery and cursor tracking.
Done when: tests cover retry, resume after downtime and no duplicate-free assumption (consumers dedupe by event id).
