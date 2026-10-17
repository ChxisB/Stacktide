# ADR-0009: IaC state - GitLab-managed Terraform state
Status: Accepted 2026-10-17 · Roadmap: D9

## Context
Stacks need remote state without the platform operating a state backend.

## Decision
v1 uses GitLab-managed Terraform state through the HTTP backend. A graph/SQL state backend (Stategraph idea) is backlog.

## Consequences
- State locking and storage are GitLab's responsibility.
- Resource-level locks and SQL-queryable state are not available in v1.
