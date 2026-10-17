# ADR-0007: Secrets at rest - AES-256-GCM envelope encryption
Status: Accepted 2026-10-17 · Roadmap: D7

## Context
The platform stores variable values, some secret, and must never leak them (invariant 1).

## Decision
AES-256-GCM envelope encryption. Each project has its own data-encryption key (DEK), wrapped by a key-encryption key obtained from a `KeyProvider`. The first provider reads the key from the environment; a KMS-backed provider comes later. Ciphertext is bound to its context with AAD.

## Consequences
- Rotating the master key means rewrapping DEKs, not re-encrypting values.
- A per-project DEK limits blast radius.
- The env-key provider is acceptable for local and early use only.
- Key handling changes are a human gate.
