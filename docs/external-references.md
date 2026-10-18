# External references

A variable can **point at a value that lives in a secret store** instead of holding it. The platform reads the
value when a sync target is planned or applied, writes it to the target and keeps it nowhere else.

```
vault://<connection>/<path>#<field>        a field of a Vault KV v2 secret
aws-sm://<connection>/<secret>[#<field>]   an AWS Secrets Manager secret, or a key of a JSON one
```

A variable whose **whole value** is one of these is a reference. Nothing else is: text that merely contains one
is just text.

- `<connection>` is the **name** of a `vault_approle` or `aws_assume_role` connection of the same organization
  (not a mount, not a URL). A name with other characters is percent-encoded.
- `<path>` (Vault) is under that connection's `prefix`: `vault://prod-vault/web/db#password` with the prefix
  `apps/prod` reads `<kvMount>/data/apps/prod/web/db`, field `password`. Up to eight names, as for a Vault target.
- `<secret>` (AWS) is the name of a secret. A name that starts with a slash is written with two:
  `aws-sm://prod-aws//team/db`. With `#<field>` the secret must be a JSON object and the field is read from it;
  without, the whole `SecretString` is the value.
- A value that starts with `vault://` or `aws-sm://` and does not parse **fails the plan**. It is never synced
  as the literal text. To store such text as a value, a reference to a secret that holds it is the way.

## Turning it on

A connection can be pointed at only if it was created with `references: true`:

```json
{ "type": "vault_approle", "name": "prod-vault", "config": { "address": "…", "roleId": "…", "kvMount": "secret", "prefix": "apps/prod", "references": true }, "secretId": "…" }
```

It is off unless set, and it is set when the connection is made (there is no way to change a connection, only
to make another). Anyone who may write variables to a project can then point at **any secret the connection's
credential can read**: under the `prefix` for Vault, and whatever the role's policy allows for AWS. Give such a
connection a credential that can read only what variables may use, and do not reuse the connection a sync target
writes through unless that is what you mean. For AWS the role needs `secretsmanager:GetSecretValue` on the
secrets (and `kms:Decrypt` for a customer key); the connection test does not check it.

## What happens to the value

- It is read **for a sync target**: when it is planned, and again when the plan is applied. Drift checks and
  auto-sync plan, so they read too.
- A reference is read **once per pass** for all the variables that hold it, one login per connection, and the
  login is revoked before the pass ends. Nothing is cached between passes. At most **50 different references**
  are read in one pass and a value may be up to 256 KiB.
- A variable that is a reference is synced **as a secret** wherever it lands, even if it was `plain`. A plain
  variable that reads it with `${KEY}` becomes a secret too, like any plain value that reads a secret.
- The text that comes out of the store is not read again: a `${…}` in it reaches the target as it is.
- The plan does not contain it, and neither does a run, an item, an audit event, a job or a log line. A plan
  line says `create DB_PASSWORD` and nothing of the value.
- Everywhere else the variable is still the pointer: the variable list and the resolved set show
  `vault://prod-vault/web/db#password` as they show any value of that variable.

## When it cannot be read

Any reference that cannot be used fails the **whole** plan or apply, so a broken pointer never reads as
"delete it". The answer names the variables and says why in fixed words, and nothing of the store:

| Status and code | Meaning |
|---|---|
| 422 `reference_invalid` | the reference or its connection is wrong: not a valid reference, no such connection in this organization, a connection of another type, a connection without `references: true`, or more than 50 different references |
| 502 `reference_failed` | the store would not give it: the secret or field is not there (or is empty), it is not text, it is too large, the credential may not read it or was refused, or the store did not answer |

A failure while a plan is **applied** fails the run (`error` on the run) before anything is written.

## Limits

- Text values only. A Vault field that is not a string, or a binary secret, is refused.
- An empty value reads as "not there".
- A plan does not see a change of the value in the store: its digest covers the variables and the target, not
  what a pointer points at. A value that changes between a plan and its apply is the one that is written. A line
  that was a no-op in a plan stays one when that plan is applied, even if the stored value changed since; the
  next plan shows the update.
- Vault KV v2 and the AWS commercial partition only, as for the targets.
- The address checks of [ADR-0013](adr/0013-target-credentials.md) apply (a literal loopback host is refused,
  private addresses and DNS rebinding are not).
- Reads of one connection go at once; a Vault with a low rate limit may refuse some of them (the plan then fails
  with `reference_failed` and can be repeated).
