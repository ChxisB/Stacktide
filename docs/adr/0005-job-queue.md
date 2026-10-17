# ADR-0005: Job queue - Postgres `jobs` table
Status: Accepted 2026-10-17 · Roadmap: D5

## Context
Sync applies, webhook handling and scheduled work need durable background execution.

## Decision
A `jobs` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`. API and worker share the codebase with two entrypoints.

## Consequences
- No Redis or broker to run.
- Throughput is bounded by Postgres; upgrade to a dedicated queue only when measured load requires it.
- Job handlers must be idempotent; delivery is at-least-once.
