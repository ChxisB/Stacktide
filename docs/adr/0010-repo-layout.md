# ADR-0010: Layout - Bun workspaces monorepo
Status: Accepted 2026-10-17 · Roadmap: D10

## Context
API, worker, CLI and web UI share types and logic.

## Decision
`apps/{api,cli,web}` and `packages/{core,db,crypto,gitlab,sync,pipelines,iac}`. Packages are created by the first task that needs them, not up front.

## Consequences
- Shared code is imported across workspaces, not copied.
- Empty packages never exist, so every package has a reason and a test.
- All GitLab traffic lives in `packages/gitlab`; all target I/O behind a `SyncAdapter` in `packages/sync` (invariant 2).
