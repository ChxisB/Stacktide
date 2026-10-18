# AWS targets

A sync target of type `aws-ssm` writes a project's variables to **AWS Systems Manager Parameter
Store**, and one of type `aws-sm` to **AWS Secrets Manager** (see the end of this page). Both are reached through an `aws_assume_role` connection (see [ADR-0013](adr/0013-target-credentials.md)):
the platform's own AWS identity assumes the role the connection names, with the connection's external
ID, and the role's short-lived keys do the work. The platform stores no AWS key of a customer.

## The target

```json
{ "type": "aws-ssm", "connectionId": "…", "config": { "region": "eu-west-1", "prefix": "/team/app", "kmsKeyId": "alias/orch", "protected": true } }
```

- A key in scope `*` is the parameter `<prefix>/<KEY>`; in any other scope `<prefix>/<scope>/<KEY>`.
- A secret is a `SecureString` (encrypted with `kmsKeyId`, or the account's `alias/aws/ssm` key), anything else a `String`.
- `protected: true` does nothing in AWS itself. It is the owner's declaration that the prefix is guarded by
  IAM, which the production guardrail ([guardrails](guardrails.md)) wants before it lets a production scope
  be synced.
- Standard tier only: values are 1–4096 **bytes** and may not contain `{{ }}`. File variables are not supported.
- The prefix has up to 13 levels and its first level may not start with `aws` or `ssm`. A scope or key is
  1–255 letters, digits, `_`, `.` or `-` (a scope can also be `*`).

## What the platform will touch

Only parameters it made. Each one carries the tag `orch-managed=<prefix>`; reading lists only those, and
an update or delete checks the tag first. A parameter made by hand, or by another target under an
overlapping prefix, is never listed, overwritten, adopted or pruned. If a variable's name is already a
parameter without the tag, applying fails with a message saying so; add the tag
`orch-managed=<prefix>` to hand it over.

## The role's permissions

The role (the one the connection names) needs, on `arn:aws:ssm:<region>:<account>:parameter<prefix>/*`:

| Action | For |
|---|---|
| `ssm:PutParameter`, `ssm:AddTagsToResource` | create (the tag is set at creation), update |
| `ssm:GetParameters` | read values |
| `ssm:ListTagsForResource` | the ownership check before an update or delete |
| `ssm:DeleteParameter` | prune |

and `ssm:DescribeParameters` on `*` (it does not support resource-level permission), plus `kms:Decrypt`
(read) and `kms:GenerateDataKey` (write) on the KMS key for secrets. The role's trust policy lets the
platform's identity assume it **only with the external ID** shown in the connection.

A missing permission shows up when the target is planned or applied, not when the connection is tested:
the connection test only proves the role can be assumed.

## Known limits

- Not verified against a real account: the adapter is tested against a contract-level fake written from
  AWS's documentation (`packages/sync/src/fake-aws.ts`).
- An update checks the tag and then writes; a parameter replaced in between is overwritten.
- No retry of throttled answers; a prefix with thousands of parameters may need one.
- At most 10 000 parameters under one prefix.

## Secrets Manager (`aws-sm`)

```json
{ "type": "aws-sm", "connectionId": "…", "config": { "region": "eu-west-1", "prefix": "/team/app", "layout": "per-key", "kmsKeyId": "alias/orch", "protected": true } }
```

The connection, the role, `protected` and the ownership rule are the same as for `aws-ssm`. What differs:

- **`layout: per-key`** (the default, and it stays the default): one secret per variable, `<prefix>/<KEY>` or
  `<prefix>/<scope>/<KEY>`; the secret is the value.
- **`layout: per-scope`**: one secret per scope, `<prefix>/<scope>` (`<prefix>/_` for `*`), holding a JSON object
  `{"KEY": "value", …}`. A write reads the object and puts it back with only its own key changed, so keys that
  someone else put in the same secret stay (and are not listed, if they are not strings or not named like a
  variable). The scope `_` is not available in this layout.
- Everything in Secrets Manager is encrypted, so "secret or plain" is kept as a **tag**: `orch-plain:<KEY>` on a
  key that is *not* a secret. A secret carries no such tag. (Up to 48 plain keys fit on one per-scope secret: a
  secret holds 50 tags and two are the ownership tags; the 49th is refused by AWS and fails the run.)
- Every secret carries `orch-managed=<prefix>` and `orch-layout=<layout>`. A target sees only secrets with both,
  so the two layouts never read each other's secrets. Hand over a secret by adding both tags.
- A new value is a new version that takes `AWSCURRENT`; the old one keeps `AWSPREVIOUS`. Reads ask for `AWSCURRENT`
  and nothing else, so a rotation's `AWSPENDING` version is never read as the value.
- Values are 1–65536 **bytes** (a per-scope secret holds all its keys within that). A name may not end in a hyphen
  and six characters, as AWS asks, and a key or scope is 1–100 characters.
- **Prune is a scheduled deletion** with the 30 day recovery window. Making the same key again inside the window
  restores the secret (per-key) and puts the new value in; a per-scope secret is never deleted, an emptied one stays
  as `{}`.

Role permissions, on `arn:aws:secretsmanager:<region>:<account>:secret:<prefix>/*`:
`secretsmanager:CreateSecret`, `PutSecretValue`, `GetSecretValue`, `DescribeSecret`, `TagResource`, `UntagResource`,
`DeleteSecret`, `RestoreSecret`; `secretsmanager:ListSecrets` on `*`; and the KMS key's `kms:Decrypt` and
`kms:GenerateDataKey` when `kmsKeyId` is a customer key.

Limits: not verified against a real account (contract fake only); one `GetSecretValue` per secret; a per-scope
secret is read, changed and put back with nothing to stop two writers at once (the last put wins); text secrets
only; no rotation or replication.
