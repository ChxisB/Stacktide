# 00 Foundation - Spec
Prefix: FND · Milestone: M0 · Status: todo

## Goal
A runnable, empty monorepo with every quality gate green and CI dogfooded, so every later task starts from a green baseline.

## Scope
Confirmed ADRs, Bun workspaces, strict TS, Biome, `bun test`, validated env config, redacting logger, local Postgres, GitLab CI for this repo.

## Non-goals
Product code. Deploy pipeline (see OPS).

## Design
- Layout per D10. Packages are created by the first task that needs them, not up front.
- Root scripts: `typecheck`, `lint`, `test`, `check` (= all three). `check` is THE gate the factory runs.
- Config: one zod schema per app; process exits listing every invalid key (never the values).
- Logger: structured JSON; redacts keys matching `/pass|token|secret|authorization|cookie|value|key/i`, including nested and headers.
- Test DB: each test file gets an isolated database/schema (helper lands in API-1).

## Acceptance
Fresh clone -> `bun install && bun run check` is green. `bun run dev:db` gives a reachable Postgres. The GitLab pipeline for this repo is green.

## Risks / human gates
FND-1 is a human gate (ADR confirmation). `git init` is new - the directory is not a repo yet.
