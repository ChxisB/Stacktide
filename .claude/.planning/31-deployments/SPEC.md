# 31 Deployments - Spec
Prefix: DEP · Milestone: M5 · Status: planned 2026-10-21, awaiting approval (nothing built) · Needs: 03, 05, 06, 11, 22 · Came from: "can we manage our full deployment life cycle with this platform? what is missing?" (2026-10-21), then "take these references and build the features"

## Goal
Close the gap between "the platform sets up CI and manages infrastructure and secrets" and "the platform manages how an **application** reaches production". Five things, each its own cut:
1. **See it.** Which build is on which environment, what the last attempt did, the history.
2. **A deploy step.** A pipeline template that builds the image, deploys it to the first environment, and can deploy any earlier build to any environment on request.
3. **Promote and roll back.** One action moves a build that already succeeded to the next environment; rolling back is promoting the previous good build to the same environment. Dry run first.
4. **Protected environments.** A promotion into one needs a second person's approval, through the change requests that already guard syncs and IaC applies (GOV-3).
5. **Know it works.** A notification when a deployment fails, and deployment frequency, failure rate and time to restore.

## What is taken from the references, and what is not
| Reference | Taken | Not taken |
|---|---|---|
| GitLab Environments and Deployments (read from the docs) | The records: a job with `environment:` makes a deployment; the Deployments API and the `Deployment Hook` webhook are on every tier | GitLab's own rollback button (retries an old job: needs its artifacts, and "prevent outdated deployment jobs" can hide it); deployment approvals and protected environments (Premium; ours are the platform's) |
| Kargo (core concepts page read; verification and auto-promotion pages not read) | Stages in order, promote a verified build onward, one view of every stage | Freight bundles of several artifacts, Warehouses, anything that needs Kubernetes or Argo CD |
| Argo Rollouts, Flagger (search summaries only) | The idea: verify after a deploy, and go back if it fails | Canary and blue-green traffic splitting: Kubernetes only, and a repository's own `deploy.sh` can do it |
| Apache DevLake (search summaries only) | The four DORA measures, from deployments alone (cut E) | Lead time (needs commit times), a DevLake feed (backlog) |
| Kamal, Dokku, Coolify (search summaries only) | The shape of a deploy script: pull the image, start it, check health, step back | Running as a platform: ours only records and orchestrates |

## Found by reading (2026-10-21)
- **Nothing in the platform knows a deployment.** `packages/gitlab` has no environments or deployments call; no `Deployment Hook` is accepted (`EVENTS` in `routes/webhooks.ts` has five); no table holds one. The three templates (`bun-app`, `node-app`, `docker-image`) end at build or `docker push`: no `environment:` and no deploy job.
- **A platform "environment" is a variable scope.** `environments` has a slug, a sort order and a `protected` flag, nothing about a deployment target.
- **One template per project.** `pipeline_configs` has `unique(project)` and a template is the whole `.gitlab-ci.yml`, so a deploy step must live in the same template as the build. Template parameters are inert scalars with a pattern, and a job cannot be switched on by a parameter, so "Helm or SSH" cannot be one template's option.
- **The platform already starts pipelines with variables.** `gitlab.pipelines.trigger(project, ref, variables)` is how IaC plans and applies start (`ORCH_CHILD_PIPELINE`); promote needs no new GitLab write.
- **Approvals already exist.** `change_requests` has kinds `variables`, `sync_apply`, `iac_apply` (GOV-3: "one approval, one apply", the author may not approve, 7 days). A fourth kind covers a promotion; no second approval system is built.
- **The pipeline token is not the person.** The platform triggers with the organization's connection token, so GitLab's own protected-environment rules apply to that token's user and not to whoever clicked. The platform's guard is the only gate on who may promote.
- **The mock GitLab has pipelines, jobs and bridges** (`packages/gitlab/src/mock/server.ts`) and no environments or deployments; cut A adds them there and to the contract suite, so the mock stays honest.

## Design
- **Decisions this feature proposes (ADR-0020, DEP-1, a human gate; it adds a decision and changes none of D1-D13):** GitLab stays the runner and holds the credentials (D1, invariant 3); a deployment is recorded as GitLab answered when asked, ordered by `observed_at` like a pipeline run (PIPE-8); a promotion is a pipeline the platform starts on the default branch with three variables; GitLab's environment **name** equals the platform environment's **slug**.
- **Records (cut A).** Table `deployments` (additive migration): organization and project, GitLab's deployment id (unique per project), environment name, sha, ref, status (GitLab's word, `unknown` for a new one), job id, pipeline id, finished time, `observed_at`, the connection that read it. **Not stored:** GitLab's `user`, commit title, anything free-text. Fed two ways: a `Deployment Hook` (allow-listed fields only, then the worker asks GitLab for the deployment, as for pipelines) and `POST .../deployments/refresh` (the latest 100, for a project whose webhook predates this feature).
- **"What is where."** For each platform environment, the newest `success` deployment is its **current** build, and the newest deployment of any status is its **last attempt**; a GitLab environment with no platform environment is listed by name only.
- **The deploy template `docker-deploy` (cut B).** It builds and publishes the image as `docker-image` does (tagged with the first 8 characters of the commit), then runs the **repository's own script** (`deployScript`, default `deploy.sh`) for the first environment (`environment`, default `staging`) on the default branch, with the image and environment in its environment variables. A pipeline started with `ORCH_DEPLOY_ENV` set runs **only** a deploy job for that environment and the sha it names (`environment: name: $ORCH_DEPLOY_ENV`, a `resource_group` per environment so two deploys never overlap); every other job is left out when it is set, as the IaC child pipeline asks. After the script, if the environment has a `ORCH_HEALTH_URL` variable (a platform variable scoped to the environment) the job checks it with retries; on failure, **when the platform named a previous build** (`ORCH_PREVIOUS_SHA`) the job deploys that again and still fails, so the deployment reads `failed` and the environment is back. The platform ships no Helm or SSH code: the script is the team's, and `docs/deployments.md` carries sample scripts.
- **Promote and roll back (cut C).** `POST .../deployments/promote {environment, sha, dryRun?}` and `POST .../deployments/rollback {environment, dryRun?}`. A rollback is a promotion of the newest earlier `success` build with a different sha to the same environment; one code path. The plan (also the dry-run answer) refuses, before any GitLab call: an unknown environment (`not_found`); a protected one is not refused here: the plan says `protected` and applying takes an approved `deploy` request (cut D, `approval_required`); a sha that no deployment of this project ever finished with `success` (`unknown_build`: only builds that worked somewhere); the sha already current there (`already_deployed`); a deployment still `running` or `created` there (`deployment_in_progress`); a project whose recorded pipeline is not `docker-deploy` (`no_deploy_pipeline`: its `.gitlab-ci.yml` would not understand the variables and would run its ordinary pipeline). Applying starts the pipeline on the project's default branch with exactly `ORCH_DEPLOY_ENV`, `ORCH_DEPLOY_SHA`, `ORCH_PREVIOUS_SHA` (the environment's current build, when it has one), answers `202` with the pipeline, and writes one audit event. The deployment appears when GitLab says so (the hook), not when the request is made.
- **Guards.** New actions in `packages/core/src/authz.ts`: `deployment.read` (project reporter), `deployment.refresh` (maintainer: it spends GitLab calls), `deployment.promote` and `deployment.rollback` (maintainer, as `run.apply` and `pipeline.retry`: it changes what runs in production with the project's runners and variables). Existing rules, no change to the model.
- **Protected environments (cut D, its own go).** A promotion or rollback into a protected environment needs an approved change request of kind `deploy` naming the environment and sha, asked by a developer, approved by a maintainer who is not the author, used up by the promotion in the same transaction that starts it. A refusal is `409 approval_required`, as for applies.
- **Know it works (cut E).** `deployment.failed` joins `NOTIFICATION_EVENTS` (payload: project, environment, short sha, pipeline link; sent once per deployment). `GET .../deployments/stats` gives per environment, over `days` (default 30): successful deployments and per week, failure rate, median time from a failure to the next success. No lead time.
- **Web and CLI.** A **Deployments** card on the Status page: a box per environment in sort order (the current build, when, a state mark with its word, a link to the pipeline), Promote and Roll back where allowed, behind a small confirm modal that shows the dry-run answer first (a small form is a modal, as in the Infisical reference). CLI: `orch deploy status | promote | rollback`.

## Scope
Cut A (see it), cut B (the template and its doc), cut C (promote, roll back), cut D (protected environments), cut E (notification and numbers), then the demo and delivery. Each cut ends with the gate green and can be approved or dropped alone; B needs only A's naming rule, C needs A and B, D needs C, E needs A.

## Non-goals
- **Auto-promotion** when a deployment verifies (Kargo's), because a CI job doing it needs a CI-token scope that may promote: an authorization decision of its own.
- **Progressive delivery** (canary, blue-green, traffic splitting) and any Kubernetes-only machinery: a repository's `deploy.sh` can call Argo Rollouts or Helm.
- **Helm, SSH or compose templates shipped by the platform.** The script is the team's.
- **More stack templates** (Python, Go, Java, .NET) and test or coverage stages: a separate feature.
- **GitHub** (feature 25), **creating, stopping or deleting GitLab environments**, review apps, a registry check that the image exists, lead time for changes, a DevLake feed, release trains of several services, undoing database migrations (a rollback does not, and the page says so).
- Building anything before you approve.

## Acceptance
- A project whose GitLab has two environments shows both boxes, each with its current build and last attempt; a failed latest attempt shows beside the build that is still running there.
- A `Deployment Hook` for a deployment makes it appear within one worker pass with only the allow-listed fields stored; a repeated or late hook changes nothing; a project without the hook is filled by Refresh.
- `docker-deploy` renders, passes the mock's lint, and its deploy script block passes shell tests: success, a failed health check that puts the previous build back and still fails, no previous build, no health URL.
- Dry-run promote of a build that succeeded in staging into production-not-protected returns from, to, previous and the variable **names**, and starts nothing; applying starts one pipeline on the default branch carrying exactly three variables and writes one audit event; each refusal code above is reached by a test.
- Rolling back picks the newest earlier good build that is not the current one, skips failed ones and the same sha, and says `nothing_to_roll_back` when there is none.
- Cut D: promoting into a protected environment without an approval is `409 approval_required`; with one it starts one pipeline and the approval is spent; a second attempt with the same approval is refused; the author cannot approve.
- No secret, variable value, GitLab user or commit text appears in a deployment answer, an audit event or a notification (exact key-list tests).
- The existing tests pass unchanged; `bun run openapi` differs by additions only; migrations are additive.

## Risks / human gates
- **First real promotion writes to a real GitLab** (a pipeline on a real project) and **the template has only met the mock's lint**: `environment: name: $VAR`, `resource_group` with a variable and the `rules` are GitLab behaviour the mock cannot prove. Both are human gates, as the first real apply of feature 09 was. Tests never touch a real GitLab (invariant 7).
- **GitLab may restrict who can set pipeline variables on a project**, which would refuse the trigger (`gitlab_refused`); the IaC plan pipelines already depend on the same setting. The doc says so.
- **Values reach a shell.** The sha is 40 hex characters and the environment a slug, both checked before they are sent and again in the template's script; nothing free-text is ever a variable.
- **The platform's guard is the only gate** (see Found by reading): a maintainer may promote to every unprotected environment of the project. Protected ones wait for cut D (ADR-0020 states it).
- **A race.** Two promotions to one environment within seconds both pass the platform's check (the table only knows what GitLab has reported); the `resource_group` makes the second deploy wait and deploy the same sha again, which a script must tolerate. A shortcut comment says so.
- **Rollback is the application, not its data.** A migration that ran stays run. The confirm modal and the doc say it.
- **Webhook change.** An existing project's GitLab webhook must also send **Deployment events**; until it does, only Refresh fills the table. Documented in DEP-10.
- **Size.** 23 tasks in six cuts. A to C (15 tasks) is the part that answers the question; D and E can wait.

## Open questions (answer at approval; the recommended answer is used if you just say "go")
1. **Where do deployments live?** In a table fed by the hook and Refresh (recommended: works with GitLab down, survives GitLab pruning old deployments, gives the numbers in cut E), or read from GitLab on each page view (no migration, a GitLab call per view, no history beyond GitLab's)?
2. **Who does the deploying in the template?** The repository's own `deploy.sh` (recommended: works for Helm, kubectl, SSH, compose, and the platform holds nothing), or templates that ship Helm and SSH-compose logic (more to build and keep right, fits fewer projects)?
3. **How does a promotion or rollback run?** A new pipeline on the default branch with `ORCH_DEPLOY_*` (recommended: no expired artifacts, not hidden by "prevent outdated deployment jobs", the same path IaC applies use), or retrying GitLab's earlier deploy job (GitLab's own rollback, but it runs the old pipeline definition and needs its artifacts)?
4. **Protected environments before cut D.** Refuse a promotion into one (recommended: safe until approvals exist), let org admins promote into one directly, or build cut D first?
5. **How are the two kinds of environment matched?** GitLab environment name equals platform slug (recommended: nothing to configure), or an explicit mapping on the platform environment (a column and a form)?
6. **What may be promoted?** Only a build that finished `success` somewhere in this project (recommended), or any commit of the default branch?
