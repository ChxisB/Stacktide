# Using Orchastrature from a GitLab CI job

A job proves who it is with a GitLab `id_token`, trades it for a token that lasts 15 minutes at most,
and then runs its commands with the variables of the environment it deploys to. Nothing is stored:
no token variable in GitLab, nothing written to disk by `orch`.

## What the platform needs

- `ORCH_CI_AUDIENCE` on the API: the `aud` the jobs ask for (for example `orch.example.com`). Without it
  the exchange answers 503 `ci_unavailable`.
- The GitLab project is registered in the platform (its `gitlab_project_id` is how the job is found), and
  the job's `environment:` name is the **slug** of an environment of that project.

## `.gitlab-ci.yml`

```yaml
deploy-staging:
  stage: deploy
  image: your-image-with-orch
  environment:
    name: staging                  # the slug of an environment in the platform
  id_tokens:
    ORCH_ID_TOKEN:
      aud: orch.example.com        # the API's ORCH_CI_AUDIENCE
  variables:
    ORCH_API_URL: https://orch.example.com
  script:
    - login="$(orch ci login)"     # fails the job if the exchange fails
    - eval "$login"                # sets ORCH_TOKEN, ORCH_ORG, ORCH_PROJECT, ORCH_ENV for the rest of the job
    - orch run -- ./deploy.sh      # runs it with the environment's variables, kept off disk
```

`orch ci login` prints `export` lines on standard output, so capture it as above. Run on its own it
prints the token into the job log. Its other output (when the token runs out, warnings) goes to standard
error.

Keep the two steps apart. `eval "$(orch ci login)"` in one line does not fail the job when `orch ci login`
fails (`eval` of nothing succeeds), and the job would carry on without a token. A shell variable holds the
token in memory only; nothing is written to disk.

## What the token can do

Only this, and only for the job's project and environment:

| | |
|---|---|
| read the project | `project.read` |
| post the plan summary of an IaC run's stack (a job with no environment) | `run.summary` (audited as the CI job) |
| read the environment | `environment.read` |
| read the environment's variables, secrets included | `secret.reveal` (audited as the CI job) |

It cannot list other environments, change anything, or create tokens. A job in a **protected**
environment (or one GitLab does not say is unprotected) is only signed in from a **protected ref**.
A job with no `environment:` gets a token for the project only, which cannot read variables. It can post a
plan summary (counts and resource addresses, never values) for one stack of one run, and only from the job
the platform recorded as that stack's summary job, on the run's own ref.

`orch run` does not pass `ORCH_TOKEN` or `ORCH_ID_TOKEN` on to the command it starts (the id_token can be traded for a new token until it expires). An id_token under another name (`--id-token-env`) is not held back.

## Options

- `orch ci login --api-url <url>`: instead of `ORCH_API_URL`.
- `orch ci login --id-token-env NAME`: when the `id_tokens:` entry is not called `ORCH_ID_TOKEN`.
- `orch --json ci login`: one JSON document with the token and what it is for.

## When it fails

| message | cause |
|---|---|
| `no id_token: give the job an id_tokens: entry named ORCH_ID_TOKEN` | the job has no `id_tokens:` entry of that name |
| `the id_token was refused` | wrong `aud`, a token from another GitLab, or it expired |
| `project_not_registered` | the GitLab project is not registered in the platform |
| `environment_not_found` | `environment: name:` is not the slug of one of the project's environments |
| `ref_not_protected` | a protected environment, and the ref is not protected |
| `ci_unavailable` | the API has no `ORCH_CI_AUDIENCE` |
