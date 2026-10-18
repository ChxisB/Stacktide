# AWS targets

A sync target of type `aws-ssm` writes a project's variables to **AWS Systems Manager Parameter
Store**. It is reached through an `aws_assume_role` connection (see [ADR-0013](adr/0013-target-credentials.md)):
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
