# 10 Drift and Policy - Spec
Prefix: POL · Milestone: M4 · Status: done

## Goal
Know when real infrastructure differs from code, tell the right people, and block unsafe changes before apply.

## Scope
Scheduled drift runs for stacks; outbound notifications; policy-as-code evaluated runner-side; built-in guardrails for variables and pipelines.

## Non-goals
Auto-remediation of infra by default, cost estimation (backlog), a policy editor UI.

## Design
- Drift = a scheduled plan-only run (`-detailed-exitcode`). Reuses the IAC run lifecycle with `kind=drift`; a non-empty plan marks the stack `drifted`. Remediation is manual.
- Notifications: a generic outbound sink interface (webhook with HMAC signature, Slack incoming webhook formatter) with retries via the job queue. GOV-4 reuses it.
- Policy (Spacelift/Stategraph idea): Rego policy sets live in a git repo, attached to stacks by tag. The generated job runs `conftest`/`opa` on the plan JSON **in the runner**, posts the result; `deny` blocks apply (IAC-8 precondition). The control plane never needs OPA.
- Guardrails: a small set of TS rules with on/off config, e.g. production secrets must not sync to unprotected targets; production variables must be `protected`.

## Acceptance
A drifted stack is detected on schedule and notified once per drift episode; a plan violating a `deny` rule cannot be applied; a guardrail violation fails the sync/pipeline plan with a clear message.

## Risks / human gates
Notification payloads must follow invariant 1 (no values). Policy evaluation failing to run must fail closed.
