# Protected environments and change requests (GOV-2, GOV-3)

An organization admin can **protect** an environment. Its variables then change only through a **change request**: someone who
may develop in the project proposes the change, a **maintainer other than the author** approves it, and the approval applies
it. The audit log records both people.

## Protecting

`PUT /organizations/:orgId/projects/:projectId/environments/:envId/protection` with `{ "protected": true|false }`. Needs the
action `environment.protect`, which is **org admin** (a project maintainer cannot lift the rule that binds them). Audited as
`environment.protection.update` with the new and the previous value. The flag shows as `protected` on the environment.

On a protected environment every write to its **own** variables is refused with `409 change_request_required`: create, update,
delete, restore one, restore the level, import and bulk edit (their dry runs and every read still work). The check runs inside
the write's transaction with the environment row locked, so protection cannot be switched on between the check and the write.
Deleting a protected environment is refused (`409 protected_environment`): unprotect it first.

Variables at the **organization and project** level are not held back, also when a protected environment inherits them: keep
production values in the environment's own variables (see "What is not covered").

## The requests

All under `/organizations/:orgId/projects/:projectId/environments/:envId/change-requests`.

| Call | Action | Who |
|---|---|---|
| `GET ""` (`status`, `limit`, `cursor`) | `change_request.read` | reporter and up |
| `GET /:crId` | `change_request.read` | reporter and up |
| `POST ""` `{ "ops": [...] }` | `change_request.create` | developer and up (an org member is a developer) |
| `POST /:crId/approve` | `change_request.approve` | maintainer, **not the author** |
| `POST /:crId/reject` | `change_request.reject` | maintainer (the author may withdraw their own) |

`ops` is the same list a bulk edit takes: `set` (key, optional kind, value), `rename` (key, to), `delete` (key); a key is named by
one step only. A request may also be made for an environment that is not protected (a voluntary review).

States: `open` → `applied` | `rejected` | `expired`. (`approved` exists in the model for kinds that are applied by a later step;
a variable change is approved and applied in one transaction.) A request expires **7 days** after it was made.

### What an approver sees

The key names and actions (`diff`), who proposed it and when: **never a value**. The values are sealed under the project's data
key, bound to the request, and dropped when it is decided or expires. Approval opens them, compares them with the variables as
they are now, and refuses the whole request (`409 change_conflict`, naming the keys) when a key it deletes or renames is gone, a
rename's target exists, or a `set` names another kind. Nothing is applied then: reject it and propose it again. A delete of a key
that is already gone counts as done. While it plans and applies, approval holds the environment (`FOR UPDATE`), so direct writes
and other approvals of that environment wait their turn, and an approval and a rejection of one request take turns too.

An environment holds at most **50 open** requests (`409 too_many_change_requests`): decide some first. The count is not taken
under a lock, so proposals made at the same moment can pass it by a few.

### Who is "the author"

A person counts once however they signed in: a session and that person's API token are one decider (`user:<id>`), so proposing
with one and approving with the other is refused (`403 self_approval`). The database enforces it too (a check on the row).
CI principals and the dev principal count by their own id; the dev principal (`ORCH_DEV_AUTH`) is one identity, so it can never
approve its own request and cannot demonstrate four-eyes.

### The record

`change_request.create`, `change_request.approve` (metadata: author kind and id, number of steps, number applied),
`change_request.reject` and, from the worker, `change_request.expire`. Approval also writes the ordinary `variable.create|update|
delete` rows, attributed to the **approver**, with `source: "change_request"`, `changeRequestId` and the author. The variable's
version history says `change request <id>` as the reason.

A closed request cannot change (a trigger freezes it); a request's diff, author, environment and expiry never change.

## Approvals to apply (GOV-3)

A change request can also be **leave to apply a plan** that a protected environment guards. It carries no values: nothing is
sealed and nothing is applied by approving it. The apply uses the approval up.

```
POST …/environments/:envId/change-requests
  { "kind": "sync_apply", "targetId": "…", "planId": "…" }
  { "kind": "iac_apply",  "runId": "…", "stacks": ["net"] }      # stacks: optional, default the planned ones
```

Asking takes `change_request.create` (project developer) and is done in the **protected** environment that guards the apply (a
sync request also needs the target to map it: `409 environment_not_protected` / `target_not_mapped`; for IaC the environment
is read from the repository when the apply runs, so it is not checked when asking). Approving takes `change_request.approve`
(maintainer, and not the author), as for variables, and needs no key provider: nothing was sealed. Rejecting an approved request
that no apply has used yet **revokes** it. The record shows `kind`, `diff` (`[{action: "apply", key: <target or stack>}]`) and `subject`
(`{runId, targetId}` or `{runId, stacks: {name: planJobId}}`); approving leaves it `approved` until an apply uses it.

**What is guarded.**

* **Sync:** an apply of a target whose `environmentMapping` maps any **protected** environment (of its project) needs an
  approved request for that plan and target. The gate is the whole target, project-level variables included.
* **IaC:** an apply of a run stack whose `stack.yml` names a protected `environment` needs an approved request that names the
  stack at the plan job it has now. Stacks that name no environment, or one that is not protected, are not held. The check
  covers the stacks being applied (`stacks`, or all that opted in on merge), and all of them must be covered by one request.
* **Auto-sync** (and drift remediation) does nothing for a guarded target: it logs and leaves the flag on; a person applies.

**One approval, one apply.** The apply takes the approval in the same transaction that claims the run, so a refused or failed
claim (stale plan, another apply running, GitLab refusing the pipeline) leaves it unspent, and two concurrent applies with one
approval start one. It is bound to the run: a new plan, a plan made again for a stack (new plan job) or another target needs a new
request. A part of the stacks an approval names, applied, uses the whole approval. An approval lapses with the request's 7 days;
the expiry job closes an unused one.

Refusals are `409 approval_required` (a merge request gets "Not applied on merge: …", a command "Not applied: …"). The
`run.apply` / `sync_run.apply` audit event carries `changeRequestId` when an approval was used.

## The worker

`change_request.expire` runs every `CHANGE_REQUEST_EXPIRE_SECONDS` (default 300, `0` = off, otherwise at least 60). It needs no
keys. Each run closes up to 10 rounds of 500 lapsed requests, drops their sealed values and writes a `change_request.expire`
event for each in the same transaction. A request past its time cannot be approved whether or not the job has run; until the job
has closed it, it still reads `open` and can be rejected. With the job off (`0`), lapsed requests keep their sealed values until
someone rejects them.

## What is not covered

* Project- and organization-level variables that a protected environment inherits.
* A way for approvers to read the proposed values (the upgrade would be a reveal endpoint gated on `secret.reveal`).
* A request title or reason, a configurable lifetime, an author withdrawing without being a maintainer.
* UI, CLI and api-client methods.
