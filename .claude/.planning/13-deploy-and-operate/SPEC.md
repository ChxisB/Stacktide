# 13 Deploy and Operate - Spec
Prefix: OPS · Milestone: M2-M4 (OPS-1/2 in M2, OPS-5 before any non-local exposure) · Status: todo

## Goal
Run the platform for real: containerised, observable, hardened, backed up, and managing its own delivery.

## Scope
Image build; self-host compose + docs; metrics; backup/restore and key rotation runbook; hardening; release pipeline; dogfooding.

## Non-goals
Kubernetes/Helm packaging, multi-region, HA Postgres (document recommendations only).

## Design
- One image, two commands (`api`, `worker`); migrations run as a separate one-shot command before start.
- Non-root, read-only filesystem where possible, healthcheck on `/health`.
- Metrics (Prometheus text): request rate/latency/errors, job queue depth and age, sync/IaC run durations and outcomes, GitLab API rate-limit remaining.
- Hardening: rate limits on login, token, reveal and webhook endpoints; strict CORS; security headers; body-size limits; `bun audit` in CI.
- The master key is the crown jewel: documented backup, rotation (`rewrap`) and restore test.

## Acceptance
`docker compose up` from the docs yields a working instance; a restore from backup into a fresh instance decrypts existing secrets; CI fails on known-vulnerable dependencies; the platform's own pipeline and variables are managed by itself.

## Risks / human gates
OPS-4 and OPS-5 are security-sensitive (`/security-review`). Publishing images or tags is a human gate.
