# 07 CLI (`orch`) - Spec
Prefix: CLI · Milestone: M2 · Status: building

## Goal
Developers and CI jobs use the platform from a terminal: pull variables, run commands with them injected, push changes, trigger sync and pipeline setup.

## Scope
Scaffold + single-binary build; login/whoami; pull/export/push; `run --`; CI mode with OIDC; thin wrappers for sync and pipeline setup; release binaries.

## Non-goals
Business logic (the CLI is a thin client over the typed API), a TUI.

## Design
- `apps/cli` built with `bun build --compile` for darwin arm64/x64 and linux x64/arm64. Uses the typed client from API-5.
- Project and environment inferred from `.orch.json` (committed, no secrets) or the git remote; flags override.
- `orch run -- cmd` injects variables into the child's environment without writing to disk, forwards signals, passes the exit code through (Infisical/EnvSync `run`).
- Config/token file `~/.config/orch/config.json` mode 0600. OS keychain is a later upgrade.
- `orch ci login` exchanges the GitLab `id_tokens` JWT (AUTH-6): no stored token in pipelines.
- Output: tables for humans, `--json` for scripts. Secret values only appear for explicit `pull`/`export`/`run`, never in tables or logs.

## Acceptance
In a repo with `.orch.json`: `orch login`, `orch pull --env dev > .env`, `orch run --env dev -- bun test` work. In a GitLab job, `orch ci login && orch run -- ./deploy.sh` works with no stored credentials.

## Risks / human gates
Anything that writes secret values to disk by default is wrong - flag it. Token storage changes need `/security-review`.
