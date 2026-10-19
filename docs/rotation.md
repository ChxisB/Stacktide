# Secret rotation (ROT-1 to ROT-10)

A `secret` variable can **rotate**: every so often a **provider** mints a new value, which becomes the variable's next
version. Everything that follows a normal edit follows a rotation: the version history, the audit log, change requests on a
protected environment, and the automatic sync to targets. The old value is never shown; what a provider minted exists only as
a sealed version.

The platform holds no cloud credentials, so v1 has two providers, both of which need none:

| Provider | `external` | What it does |
|---|---|---|
| `random` | no | Draws `length` characters (8 to 256, default 32) from `alphabet` (`alphanumeric`, `hex`, `base64url`, `numeric`). Nothing outside the platform changes. |
| `gitlab-token` | yes | A GitLab project access token, rotated through one of the organization's GitLab connections. The old token ends at once (see below). |

An **external** provider creates a credential at another system. It names it with a **handle** (a token id, never the token),
and the credential it replaced stays valid for `graceDays` so that what still holds the old value keeps working, then is
revoked. A provider that ends the old credential itself, in the same step as it makes the new one (`gitlab-token`), has no
grace to keep: `PUT` answers `422 grace_unsupported` for a `graceDays` above 0, and a rotation records no replaced credential.

## The `gitlab-token` provider

```json
{ "provider": "gitlab-token", "config": { "connectionId": "<uuid>", "projectId": 42, "tokenId": 7, "expiresInDays": 90 }, "intervalDays": 60 }
```

- `connectionId` is one of **this organization's** GitLab connections (another organization's, or one that is not GitLab's,
  is refused, and a refusal reaches GitLab with nothing). `projectId` and `tokenId` are GitLab's numeric ids, and
  `expiresInDays` (1 to 365, default 90) is how long each new token lives **at least**: GitLab ends a token at 00:00 UTC of a
  date, so the date asked for is a day later and the token lives `expiresInDays` to a day more. The config holds ids and that
  number, never a token.
- A rotation calls GitLab's `POST /projects/:id/access_tokens/:token_id/rotate`, which makes a new token with the old one's
  name and scopes and **revokes the old one in the same call** (checked against GitLab's documentation; there is no overlap).
  The new token becomes the variable's next version, and the config moves on to its id.
- The connection's token must be a personal access token with the `api` scope (GitLab refuses to rotate another token with
  less), and must not be the token being rotated. `intervalDays` has to be **shorter** than `expiresInDays`, or the token
  expires before its replacement (`422 interval_exceeds_lifetime`).
- The call is **never retried**: one GitLab carried out, sent again, would aim at a token it had already ended.
- It cannot wait for approval, so a protected environment refuses it (`409 rotation_denied`), as for any external provider.
- If an answer is lost (a timeout, or the version cannot be saved afterwards) the old token is already gone and the variable
  holds a dead value. The next rotation then aims at the dead token and GitLab refuses it, so the rotation fails and, after
  three failures, says so (below). A person creates or rotates a token in GitLab and sets the rotation's `config` to its id.
  When a rotation did mint a token but its write is lost, the new token is **kept** and the next attempt rotates it, since the
  old one is gone either way (see "All or nothing" below).

## Setting one

At each of the three levels, next to the variable:

```
/organizations/:orgId/variables/:varId/rotation
/organizations/:orgId/projects/:projectId/variables/:varId/rotation
/organizations/:orgId/projects/:projectId/environments/:envId/variables/:varId/rotation
```

| Call | Action (project, environment / organization) | Who |
|---|---|---|
| `GET` | `variable.rotation.read` / `variable.org.rotation.read` | project reporter / org viewer |
| `PUT` | `variable.rotation.manage` / `variable.org.rotation.manage` | project maintainer / org admin |
| `DELETE` | `variable.rotation.manage` / `variable.org.rotation.manage` | project maintainer / org admin |
| `POST …/rotate` | `variable.rotation.run` / `variable.org.rotation.run` | project maintainer / org admin |

A provider that acts **outside** the platform (`gitlab-token`; `external` in the table of providers) also needs
`connection.read`, an org admin's: its config names a target by number and the organization's connection token acts on it,
so a project maintainer cannot aim it (`403`). Setting `random`, removing a rotation and rotating one an admin configured
stay the maintainer's.

`PUT` replaces the whole setting:

```json
{ "provider": "random", "config": { "length": 40, "alphabet": "hex" }, "intervalDays": 30, "graceDays": 3, "enabled": true }
```

- `intervalDays` is 1 to 365; `graceDays` is 0 to `intervalDays` (default 0); `enabled` defaults to `true`.
- `config` may be left out: the stored config stays while the provider does, and a new provider starts from none. The stored
  one is read with the variable held, so a rotation that moved its config on (a new token id) is not put back.
  It holds ids and settings, never a secret (at most 2000 characters).
- The first rotation is due one interval from now. An unchanged interval keeps its place; a changed one counts from now.
  Changing the provider or the config of a rotation that was failing clears its failures and tries again at once; switching
  one back on that was off counts from now, not from when it was left.
- Only a **live secret** can rotate (`422 not_secret` for a plain variable or a file), and at exactly the level in the path.
- **The config is write-only.** No answer carries it, nor the handles of credentials at a provider: `GET` shows the provider,
  the schedule, the last result and `revokePending`.

`POST …/rotate` rotates now, whether or not the rotation is enabled, and answers

- `{"result":"rotated","version":4}`: the new value is the variable's current version;
- `{"result":"waiting","changeRequestId":"…"}`: a protected environment, see below;
- `{"result":"skipped","why":"claim_lost"}`: a worker was rotating it at the same moment and finished first
  (`variable_gone` and `protection_changed` are the other reasons);
- `502 rotation_failed`, `409 rotation_denied` or `422 invalid_config` when the provider could not: the current value is
  still in use and the failure is counted like a worker's (below). The answer carries a code, never the provider's text.

It is rate limited per caller (`rotation_run`, 20 a minute): each run creates a credential at a provider.

## From the command line

`orch rotation` does the same through the API, naming the variable by key (or id) at the level `--level` says (`env`, the
default, `project` or `org`; the target flags and `.orch.json` work as for the other commands):

```
orch rotation set DB_PASSWORD --provider random --interval 30 --grace 3 --config '{"length":40}' --org acme --project web --env prod
orch rotation show DB_PASSWORD --org acme --project web --env prod
orch rotation run DB_PASSWORD --yes --org acme --project web --env prod
orch rotation rm DB_PASSWORD --org acme --project web --env prod
```

- `set` replaces the whole setting like `PUT` does: `--provider` and `--interval` are needed, `--grace` defaults to 0,
  `--disabled` switches it off, and `--config` (a JSON object of ids and numbers, never a secret) is left out to keep the
  stored one. Mistakes in the flags stop before a request is sent, and no message repeats the config.
- `run` asks first, because the old value stops being the variable's current one; a script passes `--yes`. It prints
  `rotated`, `waiting` (with the change request) or `skipped`, and a failure by its code: **never the new value**. Read that
  with `orch pull` or `orch run` like any other value.
- `show` prints the provider, schedule and last result; `--json` (global) prints the document the API sent, for every step.
- `rm` removes the setting without asking. What the API refuses (`revoke_pending`, `not_secret`, a reader's `set`) is
  printed as the API says it.

## In the web UI

Each secret in the variables grid has a **Rotation** button. The panel shows the provider, the schedule and the last
result: *never rotated*, *last rotated* (or *attempted*) with its time, *failing* (with the short code and how many
attempts in a row failed, and that the current value is still in use) or *waiting for approval* (a protected environment).
It switches the rotation off and on (the interval, the grace and the stored config stay) and **Rotate now**, after a
confirmation. A rotation is *set up* from the command line, because its settings depend on the provider; a secret without
one says so and shows the command. The panel never shows a value: the grid reloads after a rotation, so a value revealed
before it is hidden again, and the new one is read with Reveal like any other.

## Protected environments

A protected environment takes no direct write, so a rotation there does not write: it **seals the new value in a change
request** authored by `rotation:<id>`, and the old value stays live until a maintainer other than the author approves. At
most one such request is open per rotation, and a later cycle that finds it open mints nothing; the status is
`pending_approval` until the next cycle.

That only works for a provider that is not `external`. A credential minted for a request that is then rejected would be
stranded, and a provider that ends the old credential would break the live value before anyone approved. So `PUT` answers
`409 rotation_denied` for an external provider on a protected environment, and a rotation that finds its environment
protected afterwards fails with `denied` rather than rotating.

## Replaced credentials

A rotation of an external provider records the credential it replaced and when to revoke it (`revokePending: true`). Until
that happens the rotation refuses what would lose track of it: `409 revoke_pending` for a new provider, a changed config or
`DELETE`. Changing the interval, the grace or `enabled` is allowed. Deleting the **variable** keeps such a rotation, switched
off, until the sweep has revoked the credential. A credential still current at that moment (the value the variable held) is
handed to the sweep too, and the row is removed once nothing is left to revoke.

## The worker

The `rotation.tick` schedule (`ROTATION_CHECK_SECONDS`, default 300; `0` switches it off; it also needs `ORCH_MASTER_KEYS`)
first revokes the credentials whose grace has run out, then rotates what is due. Leases have a schedule of their own,
`lease.sweep` (every 60 seconds, needs `ORCH_MASTER_KEYS`, not switched off by `ROTATION_CHECK_SECONDS=0`), so a live token
is ended on time whether or not rotation is on, and one job failing never holds up the other.

- **Exactly once.** A worker claims a due rotation with a 15-minute lease and finishes only while the lease is its own, so
  two workers never rotate one variable, and a worker that dies leaves it to be tried again when the lease runs out. "Rotate
  now" takes the same claim.
- **Failure.** The old value stays live, and the rotation waits 10 minutes, then twice as long each time up to 12 hours. The
  third failure in a row marks it `failing`, audits `variable.rotate_failing` and sends the project's `rotation.failing`
  notification once (see [iac.md](iac.md)). An organization's own variables have no project to tell: the audit event, which
  [audit forwarding](audit.md) carries, is their signal. A row holds a short code (`failed`, `denied`, `invalid_config`),
  never the provider's text.
- **All or nothing.** The new version, its audit event and the rotation's bookkeeping commit together. If they cannot, the
  credential just minted is revoked and the old value stays live. Two exceptions, both ones where revoking could do harm:
  a provider that ended the credential it replaced (`gitlab-token`) keeps the new one, because the old is dead already, and
  the next attempt rotates it; and a write that failed without saying whether it was kept leaves the credential alone when
  the rotation's row names it. Not being able to find out is logged and treated as kept: a credential nobody holds the value
  of does little harm, a live one revoked is an outage.
- **Counting a failure never undoes itself.** The failure is counted and backed off first; telling the project (audit event
  and notification) is a separate step. If that step fails the rotation is still `failing`, but the alert is lost and is not
  sent later.

## Leases

A **lease** is a short-lived credential made for one caller and ended on a clock, not a value in a variable. The decision
record is [ADR-0014](adr/0014-dynamic-secrets.md). The only provider is `gitlab-token`: a project access token for the
project's own GitLab project, made through one of the organization's GitLab connections.

| Limit | Value |
|---|---|
| Lifetime | 3600 s by default, 60 s at least, 86400 s at most (a constant, not a setting) |
| Live leases per principal | 20, counted across organizations; an ended or expired lease does not count |
| Renewal | none: take another |
| Scopes | `read_api`, `read_repository`, `read_registry` (at least one); Reporter access. A request cannot widen this |
| GitLab project | read from the platform project, never from the request |

- **The value is returned once** and is in no row, audit event or log. A lease keeps who, what, where and until when, and the
  token's id (its **handle**, kept in the open: an id is not a credential).
- **Ended twice over.** The `lease.sweep` schedule revokes every lease past its expiry (audit `lease.expire`, actor
  `system:lease-sweep`; up to 100 per run), and the token itself carries GitLab's own expiry for the day after the lease. A
  revoke the provider cannot do leaves the lease live and the next run tries again; one failure never stops the others.
  Revoking twice, or a token GitLab no longer has, is done, not an error.
- **All or nothing.** The row is made before the credential, so no token exists that no row can name. If the provider fails the
  row is dropped; if the handle and audit event cannot be recorded the token is revoked and the row dropped; if that revoke
  fails too, the row keeps the handle so the sweep ends the token at its expiry.

### Taking one

`POST /organizations/{org}/projects/{project}/leases` with `{"scopes":["read_repository"],"ttlSeconds":600}` answers `201` with
the lease and its `value` (and `cache-control: no-store`). `GET .../leases` lists the project's leases (never a value or a
handle); `DELETE .../leases/{id}` ends one (`204`; `409 lease_ended` if it already had). Another provider name is
`422 unknown_provider`.

| Who | May |
|---|---|
| Developer and up | take a lease; end any lease of the project |
| Reporter and up | list the project's leases |
| A CI job | take and end its **own** leases (a lease is held by its GitLab job, in the name `ci:<project id>:job-<job id>`, so a second token for the same job shares one allowance; a job whose token carries no job id gets no lease scopes). A job's lease ends no later than the job's own token (a shorter `ttlSeconds` is kept; one that would be cut below 60 seconds is `409 ci_token_ending`) |

- `POST` is rate limited per caller (`lease_issue`, 20 a minute) and capped at 20 live leases per principal
  (`429 too_many_leases`).
- The organization needs **exactly one** GitLab connection: none is `409 no_gitlab_connection`, several `409
  connection_ambiguous` (a project's link does not say which instance its id belongs to, so a lease is refused rather than
  guessed). A project not linked to GitLab is `409 project_not_linked`.
- The lease is made on the GitLab project the platform project is **linked** to, so changing that link (`PATCH
  .../projects/{project}` with `gitlabProjectId`, also to unlink) needs `project.create`, an org admin's, as creating a project
  with a link does. A maintainer may still change the rest of the project.
- A provider failure is `502 lease_failed` and a refusal `409 lease_denied`, in fixed words: GitLab's text is not repeated.

**In CI.** The `/auth/ci/exchange` token of a job on a **protected ref with no environment** carries `lease.issue` and
`lease.revoke` beside `project.read` and `run.summary`; the job is then a developer of its project, held by those scopes to
leases and the two reads. A job on an unprotected ref, or tied to an environment, gets neither: it reaches nothing but its
environment's own resources. A job of another project finds nothing (`404`).

**From the command line.** The token is the only thing on stdout, so it can be captured; the rest goes to stderr.

```sh
TOKEN=$(orch lease issue --scopes read_repository,read_api --ttl 900 --org acme --project web)
orch lease list --org acme --project web
orch lease revoke 0190f5a0-... --org acme --project web
```

`--json` prints one document, with the token as `value` for `issue`.

Known limits: a crash between GitLab's answer and the handle being recorded leaves a token nothing can revoke, which ends at
its own expiry (a day after the lease at most); a lease with no recorded handle cannot be revoked (`409 lease_unrevocable`);
a lease goes with its project (the token still ends at its own expiry); a deleted connection leaves the sweep retrying until
then. GitLab ends a token at midnight UTC *starting* the date it is given, so the date a day on is used: never early.

## Audit

By names and numbers only, never a value or a config:

| Action | When |
|---|---|
| `variable.rotation.set`, `variable.rotation.delete` | a person changed or removed the setting |
| `variable.rotation.run` | a person rotated now; carries `result` (or `code` when it failed) |
| `variable.rotate` | a rotation made a version or a change request (actor `rotation:<id>`) |
| `variable.rotate_failing` | the third failure in a row |
| `lease.issue`, `lease.revoke` | a person or a CI job took or ended a lease (provider and scopes only) |
| `lease.expire` | the sweep ended a lease at its expiry (actor `system:lease-sweep`) |

## Not covered

- Providers that need a credential for a cloud account or a database are not in v1: the control plane does not hold one
  (see [ADR-0014](adr/0014-dynamic-secrets.md)).
- A credential that cannot be revoked (the provider is gone) stays recorded and is retried on every tick until a person
  removes it from the database.
- Counters of the `rotation_run` limit live in each API process, like the other rate limits.
