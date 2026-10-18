# Planning Terraform stacks on merge requests

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

  Without the first three the worker logs which are missing and plans nothing.
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
- **Closed, merged, approved, commented:** ignored here. Applying belongs to the apply flow (IAC-8).
- **Pipeline events (also those of the child pipeline):** each stack moves along its plan job, and the note
  is written again.
- A commit that touches no stack, a stack file that does not parse, dependencies that cannot be ordered,
  a pipeline GitLab refuses, and more than 100 affected stacks are each said in the note, with nothing
  started.

## What to know

- **A merge request from a fork is not planned.** The plan runs in the project's CI with the project's
  credentials; whoever wrote the commit would choose what runs. The note says so.
- **Whoever can push a branch controls `.gitlab-ci.yml` on it**, so controls what the plan pipeline
  runs. Planning is read-only by design, but the job can read what the runner can: give the plan jobs
  credentials that read state and nothing else. The apply flow must also require an approved merge
  request, a head commit that matches the plan, and a protected CI file.
- The generated plan jobs save `plan.tfplan` and `plan.json` as artifacts. A plan holds the values of
  secrets, so the artifacts are limited to developers (`access: developer`, which needs a recent GitLab: believed 16.11) and
  expire after a week.
- The note shows counts, so a plan that only reads shows 0 / 0 / 0.
