# 00 Foundation - Log

## Run policy (set by user 2026-10-17, away ~6h, batch run through the roadmap)
- D1-D12 confirmed as proposed.
- One local commit per task on `main`; nothing is pushed, no remote.
- Gates: keep going; user reviews every task on return. Local design gates (crypto, authz model, migrations) are built to the approved SPEC and tagged **REVIEW** in the log. Outward-facing steps (real GitLab/cloud write, publish, push, MR) are NOT done: documented and left opt-in; a task that cannot finish without one is `[!]`.

## 2026-10-17 FND-1
- Wrote `docs/adr/0001..0012` from ROADMAP D1-D12 (all Accepted). ROADMAP decisions table marked confirmed.
- Gate: docs only, no code; `/code-review` and `/security-review` not applicable.
- Follow-ups: API-1 verifies Drizzle on `Bun.sql` (ADR-0004); UI-1 revisits ADR-0011.
