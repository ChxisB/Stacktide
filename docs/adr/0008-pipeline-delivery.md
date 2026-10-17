# ADR-0008: Pipeline delivery - render inline via MR
Status: Accepted 2026-10-17 · Roadmap: D8

## Context
Projects need a working `.gitlab-ci.yml` with minimal setup and no extra infrastructure.

## Decision
v1 renders the chosen template inline into the project's `.gitlab-ci.yml` and delivers it as a merge request. Nothing is pushed to a default branch (invariant 6). `include` / CI-component mode is later.

## Consequences
- No separate templates repo to host or version.
- Each project carries its own copy; updating means opening a new MR.
- Re-runs with unchanged config must produce no new commit.
