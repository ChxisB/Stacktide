# Deployments (DEP-1 to DEP-23)

The platform does not deploy anything. **GitLab CI runs your deploy, and your repository's own script does it**; the platform
sets the pipeline up, remembers what GitLab says was deployed where, and starts a deploy of a build you pick (or puts the
last one back). It holds no cloud, cluster or SSH credential: those are CI/CD variables in GitLab, scoped to the environment.
The decision is [ADR-0020](adr/0020-deployments.md).

> The template's `environment:`, `resource_group:` and `rules:` have so far run against the platform's model of GitLab's CI
> lint, not a real GitLab. Run the first deploy on a project you can afford to break.

## The three parts

| Part | What it is |
|---|---|
| The template `docker-deploy` | A pipeline that builds the image, pushes it to the project's registry and runs your `deploy.sh`. |
| The records | GitLab tells the platform about each deployment; the **Deployments** card on the Status page and `orch deploy status` show what is where. |
| Promote and roll back | The platform starts a pipeline that runs **only** the deploy, for a build you name: **Promote** and **Roll back** on the card, or `orch deploy promote` and `orch deploy rollback`. A protected environment needs an approval first. |

## The names must match

A deployment is recorded under the name GitLab gives its environment. The platform finds its own environment by **slug**, so
a GitLab environment called `staging` belongs to the platform environment whose slug is `staging`. Nothing is configured:
name them the same. A GitLab environment with no platform environment is listed by name on the card and in `orch deploy
status`, and nowhere else.

## Setting it up

```
orch pipeline setup docker-deploy --param environment=staging
```

That is the usual pipeline setup: one merge request, the lint verdict first. The parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `environment` | `staging` | The environment a merge to the default branch deploys to: its slug. |
| `deployScript` | `deploy.sh` | The script in your repository that deploys, from its root. |
| `deployImage` | `docker:27` | The image the deploy job runs in. It needs the script's own tools, and `curl` when you set a health URL. |
| `dockerVersion` | `27` | The tag of the `docker` and `docker:dind` images that build the image. |
| `dockerfile` | `Dockerfile` | The Dockerfile, from the repository root. |
| `context` | `.` | The build context, from the repository root. |

A merge request builds the image and pushes nothing. A merge to the default branch pushes it tagged with the first 8
characters of the commit (and `latest`), then runs the deploy job for `environment`. `docker-deploy` is chosen, never
recommended: a Docker project is still offered `docker-image`.

Tick **Deployment events** on the project's webhook as well as the ones it has (the connection's webhook secret is set up as
[the README](../README.md) says). Until it does, only **Refresh** on the card (or `POST …/deployments/refresh`) fills the
records: it reads GitLab's newest hundred deployments, which is all a missed hook needs.

## Reading what is deployed

The **Deployments** card on the Status page has a box for each of the project's environments, in the order the project lists
them (dev, then staging, then production, say): the build that is there now, when it went, and under it, when the newest
attempt was not that build, **Last attempt** with its status. **Refresh** reads GitLab again (a project maintainer may; the
page offers it to everyone and shows the API's refusal to a reporter).

```
orch deploy status [--env <environment>] [--stats]
```

prints one line for each environment: the current build and, when a newer attempt failed or is running, that one. `--json`
gives the same as data.

### The numbers

Under each box is one quiet line, `4 deployments a week · 1 failed in 12 · back in 8 min`, and `orch deploy status --stats`
adds it to each line (and a `stats` key to `--json`). It is **the last 30 days** and nothing else: the page says so only in
the line's hover text, so on a touch screen the window is not shown.

- *deployments a week* counts the deployments that succeeded, over the window.
- *failed in N* is the failures out of the successes and failures in the window. A deployment that is still running, was
  canceled or has not started is not counted.
- *back in* is the median time from the first failure of a run of failures to the next success in that environment. A failure
  that was never followed by a success counts for nothing, and the line says `back in -`.
- A dash for the whole line means nothing succeeded or failed in the window. It is not a zero.

The window uses the database's clock. It counts the newest 10,000 outcomes of the window, so an environment that deploys
more often than that is under-counted; the platform is not a metrics store, and the numbers are a quick read rather than a
report.

## Promote and roll back

**Promote** deploys a build to an environment. The dialog offers the builds that have succeeded in this project (the newest
hundred), starting with the one that is in the environment before this one. It first asks the platform what it *would* do (a
dry run) and shows it: what is there now, what is going there, and that, if a health check is set up and fails, the old build
is put back. **Start deployment** waits for that answer. A dry run writes an audit row, as every API call that succeeds does.

**Roll back** deploys the build that was in the environment before the current one. It is the same pipeline as a promotion,
and has every refusal a promotion has. **Rolling back is the application, not its data**: a database migration that ran stays
run.

```
orch deploy promote <environment> [--sha <sha>] [--dry-run] [--yes]
orch deploy rollback <environment> [--dry-run] [--yes]
```

Without `--sha`, a promotion deploys the build that is in the environment before this one. Without `--yes` the command shows
the plan and asks; with it, it starts at once. `--dry-run` shows the plan and starts nothing. The pipeline's address is
printed.

A promotion is refused, in words that say why, when: the build was never deployed successfully in this project
(`unknown_build`), it is already what is deployed there (`already_deployed`), a deployment to that environment is running
(`deployment_in_progress`), the project is not imported from GitLab (`not_linked`), or the project's pipeline was not set up with the
`docker-deploy` template (`no_deploy_pipeline`). A project maintainer may promote and roll back; the API is the gate, so a reporter who presses the
button is answered with the refusal, in the dialog.

## Protected environments

An environment can be **protected** (the flag a variable change already uses, see [change requests](change-requests.md)).
Starting a deployment there needs an **approval from someone other than the person who asked**:

1. The person presses Promote (or Roll back) and the dialog says it needs one. The button reads **Ask for approval**; it
   makes a request for exactly that build. `orch deploy promote production` does the same and exits 0 with the request's id
   and the command to approve it: exit 0 means the *ask* worked, not that anything was deployed.
2. Another maintainer sees the request in the environment's box and presses **Approve** (or **Reject**), or runs
   `orch deploy approve <environment> <request-id>` (`reject` likewise). The person who asked cannot approve their own
   request (`403 self_approval`).
3. The one who asked presses the button again, now **Start deployment**; the command is run again. The approval is **used
   up**: it is for that build and that environment, once, and it lapses 7 days after the request was made. A rollback asks for
   the build it would restore.

A dry run neither needs nor spends an approval. If GitLab refuses to start the pipeline, the approval is not spent. The
approval and the start happen in one transaction, so two requests with one approval start one pipeline.

## Told when a deployment fails

Subscribe a notification sink to the event `deployment.failed` ([iac.md](iac.md) says how and what a message holds). It is
sent once when a read of GitLab (the hook or Refresh) turns a deployment of the project to `failed`, with the environment,
the first 8 characters of the build and GitLab's address of the pipeline. A read that repeats `failed` tells nothing; a
failure after a retry that had started again is told again, as new news.

## The contract of `deploy.sh`

The job runs `./deploy.sh` (or your `deployScript`) from the repository root, after it has checked the values below. It is
your script, in whatever shell its first line names.

| Variable | Is |
|---|---|
| `IMAGE` | The image to deploy, with its tag: `registry.example/group/project:3f2a9c1e`. |
| `IMAGE_TAG` | The tag alone: the first 8 characters of the build's commit. |
| `ORCH_DEPLOY_ENV` | The environment's slug. |
| `ORCH_DEPLOY_SHA` | The build's full 40-character commit sha. |

- **Run twice for one build, it must do no harm.** Two deploys to one environment never overlap (GitLab's `resource_group`), and
  a second one that was waiting runs the same build again.
- **Exit 0 means deployed; anything else means failed**, and GitLab records the deployment as `failed`.
- A script that fails does not put anything back: a deploy that stopped half-way is yours to make safe. The health check
  below is what says "it started, and it is wrong".

### A health check, and putting the old build back

Set a variable `ORCH_HEALTH_URL` on the project **scoped to the environment** (in the platform: a variable of that
environment, put on the project's GitLab by a sync target whose environment mapping sends the environment's slug to the
GitLab scope of the same name). After the script, the job asks that address with `curl` (five retries, five seconds apart),
and an HTTP error (400 or above) or no answer at all is a failure. Then:

- when the pipeline came from a promotion, which names the build that was there before (`ORCH_PREVIOUS_SHA`), the job runs
  your script **again for that build** and fails the job anyway, so the environment is back and the deployment still reads
  `failed`;
- when there is none, the job just fails.

With no `ORCH_HEALTH_URL` there is no check. If it is set and the image has no `curl`, the job stops **before** it deploys.

## What a promotion carries

A pipeline the platform starts on the default branch with `ORCH_DEPLOY_ENV` set runs the deploy job and nothing else (no
build, no push, no scan), for exactly these three variables, and nothing free-text:

| Variable | Is |
|---|---|
| `ORCH_DEPLOY_ENV` | The environment's slug (the same rule the platform's environments have). |
| `ORCH_DEPLOY_SHA` | The build to deploy, 40 hexadecimal characters. |
| `ORCH_PREVIOUS_SHA` | The build that was there, when there was one. |

The script block checks all three before it runs yours, so a value that is not a slug or a sha stops the job. **Rolling back
is the application, not its data**: a database migration that ran stays run.

## Two settings in GitLab that matter

- **The connection's token needs the `api` scope to start a pipeline.** The platform starts pipelines with the connection's
  token, so GitLab's own rules about who may deploy to a protected environment apply to *that token's user*, not to the person
  who clicked. The platform's own checks are the gate on who may promote.
- **The platform's approval binds the platform, not GitLab.** A person who can run a pipeline in the GitLab project can start
  the deploy job with `ORCH_DEPLOY_ENV` and `ORCH_DEPLOY_SHA` set, by hand, without the platform's button and so without an
  approval. What stops that is GitLab's own **protected environments** (who may deploy to the environment) and the setting
  below. Protect the environment in both places.
- **A project can limit who may set variables when starting a pipeline** (its CI/CD settings). If it has, and the token's user
  is below that role, GitLab refuses the promotion. The plan pipelines of IaC stacks depend on the same setting.

## Two scripts to start from

These are text, not code the platform ships. Credentials are CI/CD variables in GitLab, scoped to the environment, masked
and protected as you need.

Helm, with a `KUBECONFIG` that is a **file** variable:

```sh
#!/bin/sh
set -eu
helm upgrade --install web ./chart \
  --namespace "$ORCH_DEPLOY_ENV" --create-namespace \
  --set image.repository="${IMAGE%:*}" --set image.tag="$IMAGE_TAG" \
  --atomic --wait --timeout 5m
```

SSH and Docker Compose, with `DEPLOY_HOST`, and `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` as **file** variables:

```sh
#!/bin/sh
set -eu
ssh -i "$DEPLOY_SSH_KEY" -o UserKnownHostsFile="$DEPLOY_KNOWN_HOSTS" -o StrictHostKeyChecking=yes \
  "deploy@$DEPLOY_HOST" "cd /srv/web && IMAGE='$IMAGE' docker compose pull && IMAGE='$IMAGE' docker compose up -d --remove-orphans"
```

Both are safe to run twice. Set `deployImage` to an image that has the tools (`alpine/helm`, an image with `openssh-client`).

## What the platform keeps

Promotions and rollbacks write an audit row with the environment, the build and, when an approval was used, the request's id.

For each deployment: its GitLab id, the environment's name, the commit sha, the ref, the status, the job and pipeline ids and
when it finished and was read. **Never** the GitLab user who deployed, the commit's title or message, or a variable's value:
the answers, the audit events and the notifications hold ids, names, shas, statuses and times only.
