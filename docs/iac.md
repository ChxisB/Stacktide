# Planning and applying Terraform stacks on merge requests

When a merge request is opened, reopened or gets a new commit, the platform works out which stacks the
change touches (and which stacks depend on them), starts a pipeline that plans them, and keeps **one note**
on the merge request: a row per stack with its state, the counts of its plan (add, change, destroy) and a
link to the plan job. The note never holds a plan or a resource address; whoever may see the plan opens
the job.

## What the platform needs

- The GitLab project is registered in the platform, and the import saw Terraform (or Terragrunt) in it. A
  project the import did not tag is not planned.
- A connection for the project's organization whose token may read the repository, start pipelines and
  write merge request notes (scope `api`), and a webhook on the project that sends **merge request** and
  **pipeline** events (see Webhooks in the README).
- The worker (not the API) has these settings, next to `ORCH_MASTER_KEYS`:
  - `ORCH_API_URL`: where CI jobs reach the API, such as `https://orch.example.com`.
  - `ORCH_CI_AUDIENCE`: the same value the API has (see `docs/ci.md`).
  - `ORCH_HELPER_IMAGE`: an image with `orch`, `curl` and `jq`, for the job that posts a plan's counts.
  - `ORCH_TERRAGRUNT_IMAGE` (only for Terragrunt stacks): an image repository without a tag; the stack's
    `version` is the tag. Terraform and OpenTofu have defaults.
  - `ORCH_TERRAFORM_IMAGE`, `ORCH_TOFU_IMAGE` (only for stacks with an `environment`, see Variables): the
    same, for an image that holds the tool **and `orch`**. It replaces the default for every stack of that tool.

  Without the first three the worker logs which are missing and plans nothing. The API needs
  the same image settings to start the apply of a stack with an overridden image, and
  `ORCH_MASTER_KEYS` (it opens the connection's token).
- Every stack that is planned has a `version` in its `stack.yml`.

## `.gitlab-ci.yml`

The platform starts a pipeline on the merge request's branch with one **file variable**,
`ORCH_CHILD_PIPELINE`: the generated pipeline. Nothing is written to the repository. The project's own
`.gitlab-ci.yml` hands it to GitLab, and only when the variable is set:

```yaml
orch-generate:
  stage: .pre
  image: busybox
  rules:
    - if: $ORCH_CHILD_PIPELINE
  script:
    - cp "$ORCH_CHILD_PIPELINE" child.yml    # a file variable is the path of a file
  artifacts:
    paths: [child.yml]

orch-plan:
  stage: test
  needs: [orch-generate]
  rules:
    - if: $ORCH_CHILD_PIPELINE
  trigger:
    include:
      - artifact: child.yml
        job: orch-generate
    strategy: depend      # required: the parent ends when the child does
```

`strategy: depend` matters. The platform decides that a stack "did not run" when the pipeline has ended
and has no job for it; a parent that ends before its child would have every stack marked failed.

Give the other jobs of the project `rules` that leave them out when `$ORCH_CHILD_PIPELINE` is set, or the
plan pipeline runs the project's whole pipeline too.

## What happens on each event

- **Opened, reopened, updated:** the merge request is read from GitLab (the event's own commit is not
  trusted) and its head commit is planned if no run has planned it. A repeated or late event finds the run
  made and does nothing. A new commit **replaces** the old run: its pipeline and child pipelines are
  stopped (best effort) and the same note now shows the new run.
- **Merged:** the stacks of the merge request's newest run that opted in with `apply_on: merge` are
  applied (see Applying). Nothing else happens on a merge.
- **Closed, approved, commented:** ignored.
- **Pipeline events (also those of the child pipeline):** each stack moves along its plan job, and the note
  is written again.
- A commit that touches no stack, a stack file that does not parse, dependencies that cannot be ordered,
  a pipeline GitLab refuses, and more than 100 affected stacks are each said in the note, with nothing
  started.

## Applying

`POST /organizations/:orgId/projects/:projectId/runs/:runId/apply` (action `run.apply`, a **maintainer**;
body `{"stacks": ["net"]}`; **the stacks that are planned** when left out, the rest left as they are) applies
the plans a run saved. It
answers `202` with the run, its stacks now `applying`; the pipeline's events then move each stack to
`applied` or `failed` (see "What happens on each event"). A stack applies **the plan its own plan job
saved**: the apply job downloads that job's `plan.tfplan` with the job token, runs `init` and then
`apply plan.tfplan`, so what was reviewed in the note is what runs.

The request is refused (409, or 422 for a bad request, with a code that says why) unless:

- the run has a merge request (`no_merge_request`), and the merge request is at the commit that was
  planned (`stale_plan`: plan it again after a push);
- the merge request is **open, approved and mergeable** (`not_approved`, `not_mergeable`; GitLab's own
  `detailed_merge_status`, so a failing pipeline, an open discussion or a conflict count), or **already
  merged into the project's default branch** (`not_open`, `not_default_branch`). A merged request runs
  on the default branch, an open one on its own branch;
- each stack named is `planned` (`not_planned`; so is the request when none is planned), has a recorded plan job (`no_plan`), and its plan is less than
  a week old (`plan_expired`: the artifact expires after a week, counted from when the stack became
  planned);
- each stack it depends on is applied or applied in the same request (`dependency_not_applied`);
- no other run is applying the same stack of the project (`apply_in_progress`: a unique index, so no
  caller can get past it).

The stacks are claimed (`planned` to `applying`) and the pipeline is started in **one transaction**: a
pipeline GitLab refuses (`gitlab_refused`) leaves every stack `planned`, and a second request for the same
stacks finds them taken. The audit event `run.apply` holds the ref, commit, merge request, `when`, the
pipeline id and its commit (`pipelineSha`, which for a merged request is the target branch's head, not
the planned commit) and the names of the stacks (at most 20, with a count), never a plan.

### Applying on merge

A stack's `stack.yml` may say `apply_on: merge` (the default is `command`). When GitLab reports a merge
request merged, the worker applies the stacks of its newest run that opted in and are not yet applied,
with no person asked: **the merge is the decision**, so protect the target branch and require approvals
there. A merge request that no stack opted in gets nothing, not even a note. One that cannot be applied (the run planned another commit, a stack is still planning,
a plan expired, a dependency is not applied) gets a line in the note: *Not applied on merge: ...*; the
others of the run stay `planned`, to be applied with the route. The opt-in is read from the code at the
planned commit, so **a merge request can opt its own stacks in**: review `stack.yml` like code that runs
`apply`.

An apply pipeline started by the platform needs the same `.gitlab-ci.yml` as a plan (above), and the
runner needs the stack's cloud credentials, as for a plan (the platform holds none).

## Commands in a merge request note

Anyone who may comment can write one of these as a whole note, one line, lower case, single spaces:

| Note | Does | Needs (GitLab role) |
| --- | --- | --- |
| `orch plan` | plans the merge request's newest commit if no run has (the same as an update event) | Developer |
| `orch apply` | applies every planned stack of the newest run, as the apply route does | Maintainer |
| `orch apply <stack>` | applies that stack only | Maintainer |

The worker reads the note from GitLab (the event names it, nothing more), so the text and the author are
GitLab's own. Roles come from the author's GitLab membership of the linked group and project, as
everywhere else (`GITLAB_URL` and `GITLAB_MEMBERSHIP_TOKEN`, which **the worker needs too**; without
them nobody holds a role and no command is answered). The commenter need not have signed in to the
platform. The audit event (`run.create` or `run.apply`) names them as `gitlab_user` and the note's id.
An apply still needs everything the route needs: an open, approved, mergeable request at the planned
commit, planned stacks, a dependency applied. What refuses it is the reply, as a note.

A note that is not exactly one command does nothing: `orch apply net app`, `ORCH APPLY`,
`orch plan net`, a second line (which could be a GitLab quick action such as `/merge`). If it starts
with `orch plan` or `orch apply` and a reader wrote it, the reply says it was not understood. Talk
(`orch seems slow`) and notes that start with `/` are ignored. Only a note being written counts, not an
edit of it, and notes GitLab wrote are never commands. The platform's replies never start with a command,
so they cannot start one.

## State

A stack that declares `backend "http" {}` keeps its state in GitLab's own Terraform state, with nothing to
configure: each generated job sets the backend's `TF_HTTP_*` variables for the stack (address, lock and
unlock addresses, `gitlab-ci-token` and `$CI_JOB_TOKEN`, all as references GitLab fills in; the job's own
token, never a stored one). The state is **named after the stack** (`name` in `stack.yml`), so renaming a
stack starts it a new, empty state. A stack that declares another backend (`s3`, `gcs`, ...) or none gets
none of this: its own backend block and the runner's credentials reach it. (A project's own `TF_HTTP_*`
CI variables are believed to win over the generated ones, as GitLab's variable precedence puts project
variables above a job's; not verified here.) Terragrunt stacks (whose backend the platform does not read) get the settings, so their
`remote_state` should be `backend = "http"` with `config = {}`. The job's user needs the role GitLab asks
to lock and write state (Maintainer).

## Variables

A stack gets the variables of a platform environment as `TF_VAR_*`, with nothing stored in GitLab. In its
`stack.yml`:

```yaml
name: app
tool: terraform
version: 1.9.8
environment: staging     # the slug of an environment of this project in the platform
```

The generated **plan** job of that stack declares `environment: staging` (with `action: access`: it reads
the environment, it deploys nothing), holds the `id_token` for the platform, signs in
(`orch ci login`, see `docs/ci.md`) and runs `init`, `plan` and `show` as
`orch run --prefix TF_VAR_ -- terraform plan ...`. The resolved variables of the environment (its own,
the project's and the organization's, secrets included) reach the tool as `TF_VAR_<NAME>`, and nothing
else of `orch`: not the platform token, not the `id_token`. Terraform matches the name exactly: the
platform variable `DB_PASSWORD` is `variable "DB_PASSWORD"` in the stack. A variable the stack does not
declare is ignored by Terraform (a warning at most for an environment variable).

- The pipeline holds no value, only the prefix. The apply job does not sign in: the saved plan already
  holds the values it was planned with.
- The tool's image must hold `orch`. Setting `environment` on a stack whose tool has no image of your own
  (`ORCH_TERRAFORM_IMAGE`, `ORCH_TOFU_IMAGE`, `ORCH_TERRAGRUNT_IMAGE`) is refused on the merge request.
- A plan job fails before the tool starts if the project has no environment of that slug, or if the
  environment is protected and the merge request's ref is not (`docs/ci.md`: a protected environment
  needs a protected ref).
- `plan.tfplan` and `plan.json` hold the values the plan was made with, secrets included: they are
  limited to developers (see below) and expire after a week.
- **Whoever can push a branch chooses the `environment` and the code that reads it.** The plan of a
  merge request runs the merge request's own `stack.yml` and `.tf` files, so an unprotected environment's
  secrets can be read by anyone who can push a branch to the project (a `local-exec`, an `external` data
  source or an output can print them). Keep real secrets in a **protected** environment: its plan then
  needs a protected ref, which a branch author does not have.
- A `TF_VAR_*` variable that is already in the job (a CI/CD variable of the GitLab project) still reaches
  the tool: `--prefix` renames the platform's variables, it does not clear the others.

## What to know

- **A merge request from a fork is not planned.** The plan runs in the project's CI with the project's
  credentials; whoever wrote the commit would choose what runs. The note says so.
- **Whoever can push a branch controls `.gitlab-ci.yml` on it**, so controls what the plan pipeline
  runs. Planning is read-only by design, but the job can read what the runner can: give the plan jobs
  credentials that read state and nothing else. The apply requires an approved merge request and a head
  commit that matches the plan, but it **does not check that the CI file is protected**: an author can
  change `.gitlab-ci.yml` on the branch, and the apply of an open request runs on that branch with the
  apply credentials. Prefer `apply_on: merge` (the default branch's CI file) for stacks that matter, and
  give apply credentials only to protected branches or environments.
- A stack is `applied` when the pipeline's job named `apply:<stack>` succeeded. A job an author names
  that way counts as one.
- The generated plan jobs save `plan.tfplan` and `plan.json` as artifacts. A plan holds the values of
  secrets, so the artifacts are limited to developers (`access: developer`, which needs a recent GitLab: believed 16.11) and
  expire after a week.
- The note shows counts, so a plan that only reads shows 0 / 0 / 0.
