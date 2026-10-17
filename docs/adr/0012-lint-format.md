# ADR-0012: Lint and format - Biome
Status: Accepted 2026-10-17 · Roadmap: D12

## Context
Need one fast lint and format tool wired into the `check` gate.

## Decision
Biome for both linting and formatting.

## Consequences
- One config file, one dependency, fast CI.
- Smaller rule set than ESLint plugins; add a rule only when a real defect class needs it.
