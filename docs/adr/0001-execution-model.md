# ADR-0001: Execution model - GitLab CI is the runner
Status: Accepted 2026-10-17 · Roadmap: D1

## Context
The platform must set up pipelines and orchestrate IaC without building a runner fleet and without holding cloud credentials.

## Decision
GitLab CI is the runner. The platform is a control plane: it generates pipeline config, opens MRs, triggers pipelines, receives webhooks, stores desired state (variables, stacks) and records runs.

## Consequences
- No runner fleet to build or secure.
- Cloud/IaC credentials stay runner-side (GitLab OIDC); the control plane never holds them (invariant 3).
- Coupled to GitLab. Own worker pools are a backlog item.

Alternative considered: own workers (Spacelift model).
