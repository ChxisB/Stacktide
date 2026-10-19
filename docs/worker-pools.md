# Worker pools (POOL-1 to POOL-6)

A **worker pool** is a name for a set of your own GitLab runners: the runner **tags** (and, if you like, the **image**) that a
stack's generated jobs ask for. It lets a stack's plan, apply and drift jobs run on runners in your own network or cloud
account. The platform still holds no cloud credentials: the runner does, as before.

> **Tags are routing, not isolation.** A job with a tag goes to a runner that has the tag. Anyone who can register a runner
> with that tag in the project, group or instance receives those jobs, and with them the credentials the job is given. A pool
> says where you *mean* a stack to run. Who may register runners with which tags is decided in GitLab, and that is the
> boundary to protect.

## The model

Per organization, a pool has a **name** (lower-case words joined by single dashes, up to 63 characters, the name `stack.yml`
uses), **1 to 10 tags**, an optional **image**, an **enabled** flag and an **is default** flag. An organization has at most 50.

| Rule | Why |
|---|---|
| A tag is letters, digits, `.`, `_` and `-`, up to 64 characters, starting with a letter or digit, and given once | It is written into a generated job: a space, comma or `$` would become a second tag or a CI variable |
| An image is a lower-case name (a registry with a port is fine), an optional `:tag` and an optional `@sha256:<64 hex>`; any other `@` is refused | `user:password@registry/image` would be kept in the audit trail, and the API refuses what the pipeline generator would (an upper-case repository, say), so a saved pool is never one that stops its stacks |
| At most one pool is the default, and **it must be enabled** | Stacks that name no pool use the default. A default that is switched off would send them to shared runners |
| The name cannot be changed | It is the pool's identity in `stack.yml`. Make a new pool instead |
| The default cannot be removed (`409 pool_is_default`) | Clear it first: it is a decision, and the audit trail shows it |

The table itself refuses a bad name, tag list or image, two defaults in one organization and a disabled default, so no path
around the API can store one.

## The API

| | Who | |
|---|---|---|
| `GET /organizations/:orgId/pools` and `GET …/pools/:poolId` | anyone in the organization | List (by cursor, oldest first) and read |
| `POST /organizations/:orgId/pools` `{name, tags, image?, enabled?, isDefault?}` | an organization admin | `201`. A name in use is `409 pool_name_taken`; the 51st pool is `409 too_many_pools` |
| `PATCH …/pools/:poolId` `{tags?, image?, enabled?, isDefault?}` | an organization admin | At least one field. `image: null` clears it. A disabled default is `409 pool_default_must_be_enabled` |
| `DELETE …/pools/:poolId` | an organization admin | `204`, or `409 pool_is_default` |

Making a pool the default (on create or on change) takes the default from the old one **in the same transaction**: there is
never none and never two, and a refused promotion leaves the old default as it was. Every change is audited as `pool.create`,
`pool.update` (with the previous values and the pool it displaced as default) or `pool.delete` (with what it was). Pools belong
to the organization and not to a stack's repository, so a merge request cannot add a pool or retag one.

## Attaching a pool to a stack

```yaml
# stack.yml
name: network
tool: terraform
pool: prod-runners     # the name of one of the organization's pools: lowercase letters, digits, single dashes
```

A stack's jobs run on:

| `stack.yml` | The stack gets |
|---|---|
| `pool: prod-runners` | that pool, even when the organization has a default |
| no `pool`, and the organization has a default | the default |
| no `pool`, no default | nothing: today's behaviour, no tags |
| a name that is not a pool, or a pool that is **disabled** | no pipeline: it is refused by name, **never** run on shared runners |

The pool is looked up when the pipeline is generated, from the organization's pools **as they are then** (names are fixed,
but making another pool the default moves every stack that names none at its next plan). The stack record the scan reads
carries the name the file gives (`pool`); the resolved pool is not stored, since the default can change without any
repository change.

## What a pipeline does with it (POOL-3)

Every job of a stack on a pool, **plan, estimate, summary and apply**, gets `tags:` with the pool's tags. A stack on no pool
has no `tags:` key, so a pipeline of an organization with no pools is unchanged byte for byte. Plans from merge requests,
scheduled drift checks and applies are all generated this way.

- **The image.** A pool with an `image` replaces the tool job's image with it, as given. It must hold the tool **and `orch`**
  (a stack with an `environment` signs in with it), which is why it also stands in for the `images.<tool>` setting that a
  Terragrunt stack or one with an environment would otherwise need. The helper, policy and cost images are not touched: their
  jobs do not run on a stack's tool image.
- **A refusal names the pool, not its contents.** `stack "net" names the worker pool "prod", which the organization does not
  have` or `… which is disabled`, or for a stack on the default, `uses the default worker pool …`. The merge request note
  carries it, an apply is `422 cannot_generate`, a drift check logs it, and none of them starts a pipeline.
- **The pipeline generator checks the pool again** (a tag that is not a plain word, no tags, an image it cannot use) even
  though the table refuses them: one message per pool, with none of the offending text in it.
- Only the stacks **selected** for the pipeline are judged: another stack's lost pool does not stop this plan.
- **Policy and cost steps run where the pool says.** A stack's policy check runs inside its summary job and its cost estimate
  is a job of its own, and both carry the pool's tags. A test writes every kind of job the generator has (plan, estimate,
  summary with a policy set, apply, with an environment stack and a default pool) and fails for any job without its stack's
  tags, so a job added later has to ask for them.
- **Secret detection is not a stack's job.** It is part of the project's own pipeline (`.gitlab-ci.yml`), which belongs to no
  stack and so to no pool: it carries no pool tags and runs wherever GitLab runs that pipeline's other jobs. If your runners
  take tagged jobs only, that pipeline's untagged jobs wait for a runner that takes them; that is true of the whole project
  pipeline, not of this job alone.

## Is the pool alive? (POOL-4)

`GET /organizations/:orgId/projects/:projectId/pools/:poolId/status?connectionId=…` asks GitLab, with the organization's
GitLab connection, which runners **that project can use** carry every tag of the pool, and counts them. An organization admin
only, as for a pipeline preview: it reaches GitLab with the organization's credential. It writes nothing, so it is not audited.

```json
{ "poolId": "…", "tags": ["prod-runners"], "state": "degraded", "online": 1, "total": 3, "reason": null }
```

| `state` | When |
|---|---|
| `healthy` | at least one runner is online and not paused, and every runner heard from lately is |
| `degraded` | some are, and some are offline or paused |
| `offline` | none is online and unpaused (this includes no runner having the tags at all) |
| `unknown` | GitLab could not be asked or would not say. `reason` is `not_permitted` (GitLab refused the connection's token: listing a project's runners needs the Maintainer role and the `read_api` scope or better), `unlinked` (the project is not on GitLab, or GitLab no longer has it) or `unavailable` (GitLab failed or did not answer) |

`unknown` is never read as `healthy`. `total` leaves out runners GitLab calls `stale` (not heard from for a long while) or
`never_contacted`, so an abandoned runner does not keep a pool `degraded` for ever. The answer is counts only: a runner's
address, description and token are not read from GitLab's list, so they cannot be shown.

What this cannot tell you: GitLab's list is **per project** (the answer is for the project in the path, and a runner of the
instance or of a group the project belongs to counts too), it has no runner **executor** (so the secret-detection warning
still cannot say whether a runner starts containers), and "online" means the runner contacted GitLab lately, not that a job
would succeed on it.

## The CLI and the settings page (POOL-5)

```sh
orch pool ls [--org acme]                       # name, tags, image, enabled, default; any member of the organization
orch pool add prod --tag prod-runners --tag gpu [--image registry.example.com/iac:1] [--disabled] [--default]
orch pool default prod                          # moves the default to prod; one pool at a time
orch pool default --clear                       # no default: a stack that names no pool gets no tags, as before
orch pool rm prod                               # the default cannot be removed: move or clear it first
orch pool ls --status --project web             # asks GitLab how each pool looks from that project
```

`add`, `default` and `rm` take an organization admin. `add` says on stderr (not with `--json`) what the box above says:
**tags route a job, they do not isolate it.** `--status` is also admin only, and uses the organization's GitLab connection
(`--connection` names one when there are several). It prints `healthy (1 of 1 online)`, `degraded (…)`, `offline (…)` or
`unknown (the connection's token cannot list the project's runners)`, and exits 0 for all of them: an unknown answer is
not an error, but it is never worded as healthy. A mistake in the words (a missing name, a flag the step does not take, an
unknown pool) exits 2 before anything is asked of the API.

Settings shows the same list to everyone in the organization who may read pools, with the warning above. An organization
admin with a GitLab connection also gets **Check health**: it asks GitLab about every pool for the project chosen next to
it, and says in words what it found, including why when it does not know. Nothing is asked of GitLab until someone presses
it. Pools are made and changed with `orch pool` or the API, not on that page.

## Limits worth knowing

- Deleting or disabling a pool that a stack names will fail that stack's pipeline generation (it never falls back to shared
  runners). A drift check leaves that stack out, logs it, and still checks the others; a merge request plan or an apply is
  refused. The API does not yet tell you which stacks name a pool.
- A merge request cannot add or retag a pool, but it can **choose** among the organization's pools with `pool:` in
  `stack.yml` (or drop the line for the default). That gives it no runner GitLab would not already offer the project, since
  GitLab alone decides which runners a project may use; a pool is not an approval of who may use it.
- An apply is generated from the pools **as they are when it is started**, not as they were at the plan. A pool retagged or
  made the default between the plan and the apply moves the apply with it, while the plan ran on the old runners. Pools are
  the organization's, not a merge request's, so this is a decision by an organization admin and not something a repository can
  cause, but the plan and the apply of one run can be on different runners.
- The settings page lists pools and checks their health; it does not make, change or delete them. **Check health** asks
  about one project at a time, through the organization's first GitLab connection.
- The platform ships no worker agent: pools are tags, and why is [ADR-0015](adr/0015-worker-pool-agent.md).
- Nothing has run on a real runner: the tests read the generated YAML. Whether GitLab routes the tagged jobs as expected is
  GitLab's behaviour, not checked here.
