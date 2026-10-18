# Vault targets

A sync target of type `vault-kv` writes a project's variables into **KV version 2 secrets** of a HashiCorp Vault
(or OpenBao, which has the same API and has not been tried). It is reached through a `vault_approle` connection
(see [ADR-0013](adr/0013-target-credentials.md)): the server's address, an AppRole role ID, the KV mount and the
path prefix the role is limited to, and the AppRole's **secret ID**, stored sealed like every other connection
secret.

## The connection

```json
{ "type": "vault_approle", "name": "prod-vault", "config": { "address": "https://vault.example.com:8200", "roleId": "…", "kvMount": "secret", "prefix": "apps/prod" }, "secretId": "…" }
```

- `address` is an https origin: no path, no credentials. A literal loopback host is refused unless the app was
  started for development.
- `kvMount` is the name of a KV v2 mount (one segment), `authMount` (default `approle`) the AppRole auth method.
  Vault Enterprise namespaces and mounts nested in a path are not supported.
- `prefix` (up to 8 names) is where the role may work. **Every path the platform asks for is under it.**
- A call is a login, the work, and a `revoke-self` of the client token. Nothing is cached: the secret ID is used
  once for each plan, apply or drift check. A revoke that fails is ignored; the token then lives until the role's
  `token_ttl`, so keep that short (minutes).
- The connection test logs in, asks `capabilities-self` what the token may do under the prefix and revokes it.

## The policy

```hcl
path "secret/data/apps/prod/*"     { capabilities = ["create", "read", "update"] }
path "secret/metadata/apps/prod/*" { capabilities = ["create", "update", "list"] }
```

That is all the platform asks for. It has no `delete` (it never deletes or destroys a version) and no `read` on
metadata (the `GET` of `data` answers with the metadata it needs). The connection test names what is missing.

## The target

```json
{ "type": "vault-kv", "connectionId": "…", "config": { "path": "web", "protected": true } }
```

- `path` (one to four names) is under the prefix: this target's secrets are `<kvMount>/data/<prefix>/<path>/<scope>`.
- **A scope is a secret.** A variable of every environment (`*`) goes in the secret `_`; a variable of the
  environment `production` goes in `production`. A scope that is a literal `_`, or has a `/` in it, is refused.
  Names are letters, digits, `_`, `.` and `-`, up to 100 characters, and do not start with a dot or a dash.
- A variable `KEY` is the field `KEY` of its secret, and its value is text. A value is up to 256 KiB, a
  secret up to 256 KiB in all, and a path up to 200 scopes.
- `protected: true` is the owner's declaration that Vault's policies guard this path, which the production
  guardrail ([guardrails](guardrails.md)) wants before a production variable is synced.

## What the platform will touch

Only a secret it made. It carries the custom metadata `orch-managed=<prefix>/<path>`.

- A secret at the path without that marker (made by hand, by another tool, or by another target) is never listed,
  written or emptied. A create fails with `exists` and a message that says which custom metadata to add; add it
  to hand the secret over. A soft-deleted or destroyed secret with the marker is ours again and is written as a
  new version.
- Inside its own secret the platform only writes the fields of the variables it syncs. A field someone else
  added stays and is listed as a secret; the target's unmanaged policy decides whether a plan ever prunes it. So
  does any other custom metadata.
- Every write is check-and-set with the version the platform read (`cas: 0` for a new secret). If someone wrote
  in between, Vault refuses and the line fails with "changed while it was being written, try again"; the next
  apply retries it.
- A delete (prune) writes **a new version without the field**. The secret stays, and the old values stay in the
  earlier versions until Vault's `max_versions` rotates them out or someone destroys them. Treat a pruned
  value as exposed to everyone who can read old versions.
- Vault has no "not a secret", so what is plain is kept as custom metadata `orch-plain.<KEY>=1`. At most 48
  fields of one secret can be plain (Vault allows 64 custom metadata entries, and the marker and other people's
  entries share them).
- Metadata is a second write, not part of the data write. A flag that comes (secret → plain) is written after the
  value, one that goes before it, so an interruption leaves a plain value flagged as a secret and never the
  other way round. A create writes the data first and then the marker; **if that fails the secret exists, unmarked,
  and reads as someone else's** until the marker is added by hand. The error says so.
- A flag left behind by a field that someone removed by hand is dropped at the next write to that secret. Custom
  metadata entries under `orch-plain.` whose value is not `1` are not flags and are kept.
- **A path that has custom metadata and no version** (made by a metadata write alone) is taken as new: the first
  create writes its data with `cas: 0` and then replaces its custom metadata with the marker. The platform cannot
  tell what was there, because reading metadata needs a capability it does not ask for.

## Known limits

- Verified by a run against a Vault 1.19.5 dev server (`packages/sync/src/vault-kv.e2e.test.ts`, opt-in with
  `VAULT_E2E_ADDRESS`, `VAULT_E2E_ROLE_ID`, `VAULT_E2E_SECRET_ID`, `VAULT_E2E_KV_MOUNT`, `VAULT_E2E_PREFIX` and
  `VAULT_E2E_ALLOW_WRITES=yes`; it writes new secrets and deletes none). The suite that runs everywhere uses
  a contract-level fake (`packages/sync/src/fake-vault.ts`) written from those answers.
- Values are text. A field that is not a string is not listed, is never replaced (`exists` with a "does not hold
  text" message) and is kept in every write; it passes through JSON, so a number beyond 2^53 loses digits.
- A read is one `LIST` and a `GET` for each scope secret, one after the other.
- The marker is a convention, not a lock: anyone who may update metadata can add or remove it.
- The metadata write is not check-and-set: it replaces all custom metadata, so a metadata change by someone else
  between the platform's read and its write (a few milliseconds, only when a flag changes) is overwritten. A
  data write is always check-and-set.
- A metadata write was checked on Vault 1.19.5 to keep `max_versions`; whether it keeps `cas_required` and
  `delete_version_after` was not checked, so set those with care on a path this platform manages.
- Every call is a login and a revoke, and a read asks for the secrets one after the other: a path of 200 secrets
  is 200 requests inside one login. Watch the AppRole's login rate limit and `token_ttl` when many projects sync
  at once.
- Any `400` from the login reads as a wrong role ID or secret ID, which is what Vault answers; a malformed
  request would read the same way.
- A wrong `kvMount` reads as an empty `LIST` (a plan then shows everything as a create), and the first write fails with Vault's status in fixed words.
- The server's address is checked for the literal loopback only; a DNS name that resolves to a private
  address is not refused (see the SSRF follow-up in the GL-6 log).
