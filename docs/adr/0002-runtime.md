# ADR-0002: Runtime - Bun, TypeScript strict
Status: Accepted 2026-10-17 · Roadmap: D2

## Context
Runtime was given as a project constraint.

## Decision
Bun with TypeScript in strict mode (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).

## Consequences
- One toolchain: runtime, package manager, test runner, bundler.
- Bun-specific APIs (`Bun.serve`, `Bun.sql`, HTML imports) are available and used where they replace a dependency.
- Tied to Bun's compatibility surface; check it before adding Node-only packages.
