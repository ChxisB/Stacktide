# ADR-0003: API framework - Elysia with Eden
Status: Accepted 2026-10-17 · Roadmap: D3

## Context
The CLI and web UI need a typed client for the API without a separate codegen step.

## Decision
Elysia, with the Eden treaty client shared by `apps/cli` and `apps/web`.

## Consequences
- End-to-end types from route definitions to clients.
- Bun-first framework; moving off it later means replacing the route layer and client.

Alternative considered: Hono plus a generated SDK (EnvSync model).
