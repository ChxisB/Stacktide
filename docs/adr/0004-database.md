# ADR-0004: Database - Postgres with Drizzle on Bun.sql
Status: Accepted 2026-10-17 · Roadmap: D4

## Context
Need relational storage for projects, variables, runs and audit, with one infrastructure dependency.

## Decision
Postgres, accessed through Drizzle ORM on the `Bun.sql` driver. Migrations are forward-only and additive (invariant 8).

## Consequences
- Single stateful dependency; also hosts the job queue (ADR-0005).
- API-1 must verify the Drizzle + `Bun.sql` combination works. If it does not, fall back to a supported Postgres driver under Drizzle and record that in LOG.md; the decision to use Postgres + Drizzle stands.
