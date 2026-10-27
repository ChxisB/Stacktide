# Which GitLab, and what it needs

The platform talks to **GitLab** (GitLab.com or a self-managed one, Community or Enterprise Edition) and to **GitHub.com**
([ADR-0019](adr/0019-multi-forge.md), still *Proposed*; the seam is audited in [forge-seam.md](forge-seam.md)). Every
claim below names the test that covers it, or says **not run against a real instance**: the tests use a mock GitLab and
a mock GitHub, and the real-instance runs are tasks of their own (GitLab FRG-8, GitHub FRG-27, neither done).

## One for sign-in, many for connections

| What | How many | Set by |
|---|---|---|
| Sign in with GitLab, and GitLab-membership roles | **one GitLab per deployment** | `GITLAB_URL` and the three `GITLAB_OAUTH_*` settings, all or none |
| Sign in with GitHub (github.com), and project roles through the repositories' collaborators | **one GitHub OAuth app per deployment** | the three `GITHUB_OAUTH_*` settings, all or none; needs `ORCH_MASTER_KEYS` ([below](#signing-in-with-github-frg-25)) |
| Organization roles through a GitHub organization's owners and members | one membership token per deployment | `GITHUB_MEMBERSHIP_TOKEN`, and an organization's `githubOrgId` ([below](#an-organization-on-github-frg-34)) |
| Sign in through another GitLab (or any OpenID Connect provider) | any number, one per organization's identity provider | [sso.md](sso.md), "A second GitLab instance as the provider" |
| Connections (import, sync, merge request notes, pipelines) | any number per organization, each with its own address and token | `POST /organizations/:orgId/connections` |
| CI job tokens (`id_token` exchange) | the deployment's GitLab, and any GitLab a connection is registered at | [ci.md](ci.md), "More than one GitLab" |

- **Project 42 of two instances are two projects.** A project imported through a connection belongs to it; one linked
  before connections existed belongs to the deployment's GitLab. Covered by `packages/db/src/project-connection.test.ts`
  and `apps/api/src/ci-instances.test.ts` ("project 42 of each instance is its own project").
- **A connection that has projects cannot be deleted** (409). `packages/db/src/project-connection.test.ts`.
- **Roles come from the deployment's GitLab only.** A project bound to a connection at another address is never asked
  about there, so user 100 of one instance cannot hold user 100 of the other's role. `apps/api/src/membership.test.ts`
  ("a second GitLab instance"). People of a second instance get roles from single sign-in role rules on `groups_direct`
  (`apps/api/src/sso-login.test.ts`). The organization's **group link is the deployment GitLab's alone**.
- **The sign-in settings are all or none**, and a CI audience needs `GITLAB_URL`: `apps/api/src/auth-config.test.ts`.
  Even a deployment whose GitLab is only a connection still sets `GITLAB_URL` for the CI exchange.
- **A connection's address is `https`** (plain `http` only on this machine, no credentials in it):
  `apps/api/src/connections.test.ts`. A trailing slash makes no difference to which instance a token is checked against
  (`packages/db/src/project-connection.test.ts`).

## Versions and tiers

The connection test (`POST .../connections/:id/test`) reads `GET /version` and reports what this instance lacks.
Only what GitLab's own documentation states is checked:

| Needs | Lack of it | Tested at |
|---|---|---|
| Hidden variables: GitLab **17.4** or later | below, at and above the boundary; an unreadable version is *unknown*, not a refusal | `packages/gitlab/src/instance.test.ts` |
| Environment scope on **group** variables: Premium or Ultimate | `no` on Community Edition; *unknown* on Enterprise Edition, because the licence tier is not in the API | `packages/gitlab/src/instance.test.ts` |

- The connection test answers `version` and `capabilities` and never the token; a GitLab that will not say its version
  still passes with nothing claimed: `apps/api/src/connections.test.ts`.
- Group variables themselves are in GitLab's Free tier; only their environment scope is Premium and up (GitLab's
  documentation, not run against a real instance).
- **Not checked:** `id_tokens` and `artifacts:access` (introduced long ago; their versions are no longer in GitLab's
  docs), and the real `GET /version` of GitLab.com or a self-managed instance (not run against a real instance).
- **Not enforced yet:** nothing stops a variable write that uses a hidden or scoped group variable on a GitLab that
  lacks it. GitLab will refuse it (not tested here, and what the platform then shows is not tested either); the
  connection test and the settings page are where the lack is shown beforehand.

## What each connection's token needs

The scopes the platform's own documents already state, one place each. A token with `api` covers every row; `read_api`
only the first, second and last. GitLab decides the scope and role each call needs: **not run against a real instance**.

| For | Scope and role | Stated in |
|---|---|---|
| Connecting, importing a project, reading it | `read_api` | README (Connections) |
| Who holds a role (`GITLAB_MEMBERSHIP_TOKEN`): a member or admin of every linked group and project | `read_api` | [self-host.md](self-host.md) |
| Planning on merge requests: start pipelines, write notes | `api` | [iac.md](iac.md) |
| Promoting and deploying: start a pipeline | `api` (GitLab's protected-environment rules then apply to the token's user) | [deployments.md](deployments.md) |
| Rotating a GitLab token variable | personal access token, `api` | [rotation.md](rotation.md) |
| Terraform state routes of a CI job | the job's project role Maintainer | [ci.md](ci.md) |
| Runner pool status | `read_api`, Maintainer | [worker-pools.md](worker-pools.md) |

The sign-in application asks GitLab for `read_user` only (`packages/gitlab/src/oauth.ts`).

## A private CA

Give the process the authority's certificate through the runtime's own variable; the GitLab client, the CI key fetch and
single sign-on discovery all obey it. The compose override is in [self-host.md](self-host.md), "Private CA". It was tried
by hand with a throwaway authority (no test): **not run against a real instance**, nor the runner's own trust of the CA.

## GitLab.com

- Set `GITLAB_URL=https://gitlab.com`. A job token's `iss` is then `https://gitlab.com` (GitLab's documentation, **not run
  against GitLab.com**; the platform's side of it is the "issuer is the instance URL without a trailing slash" test in
  `apps/api/src/auth-config.test.ts`).
- **The OAuth application.** On GitLab.com, a user's *Settings > Applications* (or a group's) creates it. Make it
  **confidential**, tick **only `read_user`**, and give it the redirect URI `https://<your host>/auth/callback`
  (`GITLAB_OAUTH_REDIRECT_URI`). Put its Application ID and Secret in `GITLAB_OAUTH_CLIENT_ID` and
  `GITLAB_OAUTH_CLIENT_SECRET`. GitLab's documentation, **not run against GitLab.com**.
- Create a connection with a token as in the table above; the connection test says what GitLab.com's version offers.
  Its licence tier is not in the API, so group-variable scopes stay *unknown* there.

## A GitHub connection

`POST /organizations/:orgId/connections` also takes `{ "type": "github", "name", "baseUrl", "token", "webhookSecret"? }`
(`baseUrl` is `https://github.com` or a GitHub Enterprise Server). The platform stores and tests the connection. Covered
by `apps/api/src/connections.test.ts`, `packages/github/src/permissions.test.ts` and `packages/forge/src/github.test.ts`;
**not run against GitHub**.

**What a GitHub project can do, and where it is described** (each against the mock GitHub only):

| Area | Section |
|---|---|
| Import repositories, roles from collaborators, variable scopes | [Import, membership and variable scopes](#import-membership-and-variable-scopes-on-github-frg-15) |
| Onboarding pull request: `orch.yml` and, with stacks, `orch-stacks.yml` | [The onboarding pipeline as a workflow](#the-onboarding-pipeline-as-a-workflow-frg-16), [the stack workflow in the pull request](#the-stack-workflow-in-the-onboarding-pull-request-frg-31) |
| Runs, retries, plan and apply of stacks, approvals | [Runs on GitHub](#runs-on-github-frg-14), [the stack workflow](#the-stack-workflow-on-github), [starting a run](#starting-a-run-frg-30), [the apply](#the-apply-and-what-holds-it-frg-29) |
| Sync to Actions secrets and variables | [Sync](#sync-to-actions-secrets-and-variables-frg-20) |
| Webhooks and pull request plans | [GitHub webhooks](#github-webhooks-frg-21), [Pull requests on GitHub](#pull-requests-on-github-frg-32) |
| A job signs in to the platform | [Signing a GitHub Actions job in](#signing-a-github-actions-job-in-frg-23) |
| The web pages | [The screens on GitHub](#the-screens-on-github-frg-24) |
| People sign in with GitHub | [Signing in with GitHub](#signing-in-with-github-frg-25) |

**What ran:** every area above against the in-process mock GitHub, and the forge contract against the same mock. **Not
run:** anything against a real GitHub (FRG-27), a workflow on a runner, a GitHub Enterprise Server. Nothing outside the
list is built for GitHub: runners and their health, project access tokens and GitLab's state backend are refused with a
sentence, and the capability flags say so. Deployments and environments are built (CLD-10, below).

- **The test reads, it does not write.** A fine-grained token's permissions cannot be read back, so the test uses the
  token for one read per permission on the first repository it sees (contents, pull requests, actions, secrets,
  variables, environments, webhooks) and says which answered. Only Contents is required. A token with read but not
  write access passes; the first write says no.
- **The webhook secret** is the one set on the GitHub webhook; it is stored sealed, since GitHub signs deliveries with
  it and the platform has to compute the signature (`packages/db/src/connections.test.ts`). It is in no response, audit
  row or log line (`apps/api/src/connections.test.ts`).
- Not supported: installation tokens (GitHub App); a webhook secret the platform makes.

### What the GitHub adapter does (FRG-12)

It answers the same operations as the GitLab one, on a mock GitHub, with the same contract test for projects,
repositories and merge requests (`packages/forge/src/github.mock.contract.test.ts`). Everything else (pipelines,
variables, members, runners, access tokens, Terraform state) refuses with "is not available for GitHub
yet", and every capability flag says no, until the task that builds it (most are built since: see the table at the top
of this section).

- **Commits go through the Git Data API** (blobs and trees, then a commit, then the branch), not one `PUT /contents` per
  file, so several files land in one commit. A branch moves forward only (`force: false`). Nothing is ever written to the
  default branch: the adapter refuses before sending anything, and a test checks every request of a run for it
  (`packages/forge/src/github.mock.contract.test.ts`).
- **A pull request is a merge request.** Merged is told from closed by `merged_at`. `mergeStatus` is `mergeable` only when
  GitHub says `clean` (or `has_hooks`); anything else keeps GitHub's word, and `unknown` is null. GitHub works the state out
  after a pull request is opened, so a create and a get a moment later can differ.
- **Approvals are read, and counted the strict way (FRG-30).** GitHub has no single "approved", so the reviews of a pull
  request are reduced to the latest word of each person: an approval counts only when it was made on the pull request's
  current commit, a change request blocks until that person approves or the review is dismissed, and a comment says
  nothing. `approved` is "no one blocks and the approvals reach the count the target branch requires", the larger of its
  branch protection and its rulesets. A branch with no protection (GitHub's 404 "Branch not protected" or "Pull request
  reviews not enabled") requires none. Anything else that cannot be read, such as a token without the rights to read the
  protection (an admin permission), is an error and not an approval: a run is never applied on a guess.
- **Limits:** a file over 1 MB is not read; a tree GitHub cuts short is refused; a comparison lists at most 3000 files
  (then `timedOut`); `removeSourceBranch` is ignored (a repository setting on GitHub); a repository list is read whole.
- **Names:** a repository is `owner/name` or its id (one more request); branch and file names are checked so they cannot
  leave the repository's URL. A branch with a `/` in a tree read is **not confirmed** against GitHub.

### Pipeline delivery and merge request notes (FRG-13)

`applyPipeline` (a file on a branch, one merge request) and the merge request note take a forge, not a GitLab client.
On a GitHub repository the pipeline file is `.github/workflows/orch.yml`, the request is a pull request, and the note is
a comment on it (`apps/api/src/pipeline-apply.github.test.ts`, `apps/api/src/mr-note.test.ts`). GitHub has no server-side
check of a workflow, so the result says **"not checked"** in place of a lint verdict, in the pull request too.

- **The routes reach it since FRG-16**, which renders the workflow (next section). The pipeline routes and the fleet
  upgrade open a connection by its type (`forgeOf`).
- Error codes keep their `gitlab_` names (`gitlab_project_unreachable`, `gitlab_failed`); the sentence says GitHub.

### The onboarding pipeline as a workflow (FRG-16)

A template that ships a `workflow.yml` next to its `pipeline.yml` can be delivered to a GitHub repository:
`renderWorkflow` fills it and applies the overrides exactly as `render` does for GitLab, and the pipeline routes choose
between the two by the connection's forge. Preview and apply commit `.github/workflows/orch.yml` on the branch
`orch/pipeline` and open one pull request, never writing to the default branch.

- **Shipped:** `bun-app`, `node-app` and `docker-image`, with the same jobs as their GitLab pipelines. `docker-deploy`
  has none and is refused by name ("has no GitHub Actions form yet") until the platform can start a run on GitHub
  (FRG-30). A new template is deliverable to GitHub when someone writes its `workflow.yml`; the loader checks it for
  parameters used and not declared, for GitLab's keys, and for a `jobs` mapping.
- **Refused, each with a sentence:** the `include` and `component` modes (a workflow is committed whole); a template
  with no workflow; `secretDetection` (GitLab's analyzer; dropping it silently would say a scan runs that does not);
  any GitLab key (`include`, `stages`, `default`, `image`, `variables`, ...) in an override. `env`, `concurrency`,
  `defaults` and `permissions` may be overridden.
- **Differences from GitLab you can see:** no dependency cache; `docker-image` pushes to `ghcr.io/<owner>/<repo>` with
  the run's own `GITHUB_TOKEN` (the job alone holds `packages: write`); `dockerVersion` has no effect (the runner has
  Docker); every action is pinned to a commit SHA (checkout v7.0.1, upload-artifact v7.0.2, looked up 2026-10-22).
- **No `id-token: write`.** The task text asked for it, but none of these jobs calls the platform, and a token a job
  does not use is a token a compromised step can use. The workflows that do call the platform (stacks, FRG-18) ask for
  it themselves.
- **Not checked by the platform.** GitHub has no server-side lint, and the platform does not run `actionlint`; the
  preview and the pull request say "was not checked". The shipped workflows are linted by a test that is off unless you
  give it a binary: `ACTIONLINT_BIN=<path to actionlint 1.7.12> bun test packages/pipelines/src/workflow.test.ts`
  (release page: github.com/rhysd/actionlint/releases/tag/v1.7.12; check the binary against the release's checksums
  file). Run on 2026-10-22 on darwin/arm64: no findings.

### Runs on GitHub (FRG-14)

The code that reads a run (`readPipeline`, `retryPipeline`, the runs page's jobs, the run events' judge) takes a forge,
so a workflow run reads the way a pipeline does: its `status` and `conclusion` become one status, its jobs become jobs
(`apps/api/src/pipeline-runs.github.test.ts`, `packages/github/src/pipelines.test.ts`). The GitLab tests did not change.

| GitHub | The platform |
|---|---|
| `requested` / `queued` / `pending` / `waiting` / `in_progress` | `created` / `pending` / `waiting_for_resource` / `manual` / `running` |
| `completed` + `success`, `neutral` | `success` |
| `completed` + `failure`, `timed_out`, `startup_failure` | `failed` |
| `completed` + `cancelled`, `stale` / `skipped` / `action_required` | `canceled` / `skipped` / `manual` |
| any word GitHub adds later, or `completed` with no conclusion | `unknown` (not a guess) |

- **No stages, no failure reason, no child pipelines.** A job has an empty stage and no reason; `bridges` is empty and
  asks GitHub nothing. The flags `stages` and `childPipelines` say so, and stay false.
- **Retry runs the failed jobs again; cancel stops the run.** Both return the run as GitHub then shows it. GitHub
  refuses a retry while the run is going (`forbidden`, answered to the caller as a refusal) and a cancel once it has
  finished.
- **Starting a run is `startRun` (FRG-30), below.** Still refused: a child pipeline (`pipelines.trigger`) and a run's
  artifacts (`pipelines.artifact`), so the secret scan of a finished GitHub run does not run.
- **Run events reach it since FRG-22; pull requests and their comments since FRG-32.** The worker's run-event, pull
  request and comment handlers open a GitHub connection for a GitHub event (below), and so does the deployment handler
  (CLD-10, below). The other consumers that start runs (state, pools, the template registry) open GitLab connections only. The pipeline delivery routes
  follow the connection's type since FRG-16. The sentences of `retryPipeline`'s refusals still
  say GitLab.
- **Mapping choices of ours:** `waiting` (held for an environment's reviewers) and `action_required` are `manual`.
  **Not run against GitHub:** that a queued job carries no start time, that a cancel reads `canceled` at once (GitHub
  cancels asynchronously, so the run may read `running` for a moment), and what a rerun reads straight after.

### Import, membership and variable scopes on GitHub (FRG-15)

The import routes (`GET .../gitlab-projects`, `POST .../imports`) open the connection and build its forge, so a GitHub
connection lists its repositories and imports them the way a GitLab one does. The route names and the body field
`gitlabProjectIds` keep their old names; for GitHub the number is the repository's id. The imported project is bound to
the connection, takes `owner/name` as its name, and the types are found from the file paths of the default branch. A
GitHub failure is said in GitHub's words (`apps/api/src/imports.github.test.ts`).

`membersApi` (`packages/github/src/members.ts`) answers `members.accessLevel` in GitLab's levels, so the code that turns
a level into a role is the same:

| GitHub | Level | Role |
|---|---|---|
| repository `read`, `triage` | 20 | reporter |
| repository `write` | 30 | developer |
| repository `maintain` / `admin` | 40 / 50 | maintainer |
| organization `admin` / `member` | 50 / 30 | owner / member |
| a custom repository role | that of its base permission (`read` 20, `write` 30, `admin` 50), else 0 | |
| anyone else, a pending invitation, a billing manager, a user or organization GitHub does not have | 0 | none |

- **A lookup costs three or four requests:** the login of the user id, whether they are a collaborator, and their
  permission. A stranger to a public repository is stopped at the collaborator check, because the permission route
  would say `read` to them.
- **A failure that is not "no such thing" is thrown**, so a lookup that did not finish never reads as no access.
- **The group lookup** (an organization's id or login) is what the variable scopes need; listing variables for GitHub is
  FRG-20.
- **Sign-in reads it through `githubRoles`, not `gitlabRoles`.** `gitlabLinks` leaves GitHub-bound projects out on
  purpose; a person who signs in with GitHub gets their roles from `apps/api/src/github-roles.ts` (FRG-25, below).
- **A GitLab event no longer finds a GitHub repository.** `linkedProjects` without a connection means GitLab's projects
  (unbound ones, and those bound to a GitLab connection), so a GitLab event for project 555 is not read as the GitHub
  repository whose id is 555 (`packages/db/src/project-connection.test.ts`, `apps/api/src/pipeline-runs.github.test.ts`).
- **Mapping choices of ours:** an organization `member` is a Developer and a billing manager holds nothing. **Not run
  against GitHub:** the routes and fields listed in `docs/forge-seam.md` section 8.

### Sync to Actions secrets and variables (FRG-20)

A `github-actions` sync target writes a project's variables to GitHub Actions. It needs a GitHub connection (a GitLab
connection is refused when the target is made and again when it is used, so its token is never sent to GitHub). The
config says whose:

| Config | Where it writes |
|---|---|
| `{ "repository": "owner/name" }` | the repository's Actions secrets and variables |
| `{ "repository": "owner/name", "environment": "prod" }` | that environment's, which only a job naming it can read |
| `{ "organization": "acme", "visibility": "private" }` | the organization's, for its `private` repositories (the default) or `all` of them; `selected` is not offered |

Any of them may add `"protected": true`, as for every target.

- **A secret is sealed, a plain value is a variable.** A variable marked secret is written as a secret: the platform asks
  for the scope's public key, seals the value to it (`sealForGithub`) and sends only the sealed text. A plain one is a
  variable and is readable on GitHub. A name is one item whichever it is: changing a variable between the two removes the
  old kind (the readable copy first, so a failure cannot leave a secret's old value in plain sight).
- **Names are capitals.** GitHub stores a name in capitals, so a key in lower case is refused with a message (it would
  read back as another key and be created again on every plan). It must also not start with a digit or with `GITHUB_`.
- **What GitHub cannot hold is refused before anything is sent:** a file, a value over 48 KB (counted in bytes) and any
  scope but `*` (Actions has no scopes). The plan names every such key at once.
- **Drift.** A variable is compared by its value. A secret cannot be read, so it is compared by the time GitHub says it
  last changed (`updated_at`) against the time recorded when the platform last wrote it, which catches an edit made by
  hand. **Nothing stores that record yet**, so a secret is always planned as an `update`; the write is idempotent, so this
  is noise and not damage. Upgrade: persist the fingerprint and the stamp after an apply, as `LastApplied` in the planner
  already expects.
- **An organization's visibility belongs to the config.** Every write sends it, so a visibility someone changed on GitHub
  is put back at the next apply.
- Writes and reads keep the token, the key and the values out of every error, run line, audit event and log: a failure says
  "GitHub answered forbidden" and names the key, and nothing else.

Not confirmed with real GitHub (FRG-27): the environment secret and variable paths, the 409 for a variable that exists,
whether a secret and a variable can share a name, whether a value is trimmed or may be empty, the size limit of a
variable and the length limit of a name.

### GitHub webhooks (FRG-21)

`POST /webhooks/github/:connectionId` is the receiver for a GitHub connection, beside GitLab's. On GitHub (the
repository's or the organization's **Settings, Webhooks**) set the payload URL to that path on the API, the content type
to `application/json` (the form encoding is a 415), the secret to the one given when the connection was made, and tick
*Workflow runs*, *Workflow jobs*, *Pull requests*, *Issue comments* and *Deployment reviews*. A webhook secret cannot be
issued by the platform for a GitHub connection (GitHub signs with the secret itself, so it is sealed, not hashed): the
issue route answers 422 `webhook_secret_set_at_creation`. Covered by `apps/api/src/webhooks.github.test.ts`; **not run
against GitHub**.

- **The signature comes first.** GitHub signs the body (`X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256), so the
  receiver reads the body, up to 1 MiB (413 above it), and compares in constant time before it looks at anything in
  it. An unknown connection, a GitLab one, one with no webhook secret (or an empty one, which would sign anything), a
  header that is missing or not that form (refused before the body is read) and a wrong signature are the same 401, and
  nothing is stored for any of them. An event the platform does not use, `ping` among them, is acknowledged
  (`ignored`) only after the signature has passed.
- **One delivery, one job.** `X-GitHub-Delivery` is required (400 without it) and a repeat of it makes no second job.
  The job goes on the same queue as GitLab's (`gitlab.event`) and carries ids and a fixed list of fields, never the
  body: no title, comment, commit message or login.

  | GitHub event | job `event` | fields (besides `connectionId`, `organizationId`, `deliveryId`, `projectId` = the repository's id) |
  |---|---|---|
  | `workflow_run` | `workflow_run` | `action`, `pipelineId` (the run), `status`, `conclusion`, `ref`, `sha`, `attempt` |
  | `workflow_job` | `workflow_job` | `action`, `jobId`, `pipelineId`, `status`, `conclusion`, `name`, `ref`, `sha` |
  | `pull_request` | `pull_request` | `action`, `iid`, `state`, `sourceBranch`, `targetBranch`, `sha`, `headRepositoryId` |
  | `issue_comment` on a pull request | `issue_comment` | `action`, `noteId`, `mrIid`; a comment on an issue is ignored |
  | `deployment_review` | `deployment_review` | `action`, `environment`, `pipelineId` |
  | `deployment_status` | `deployment_status` | `action`, `deploymentId`, `status`, `environment` |

- **Named as GitHub names them.** Nothing written for GitLab's events (`pipeline`, `merge_request`, `note`,
  `deployment`) matches these, and `linkedProjects` without a connection means GitLab's projects only, so the
  repository with id N can never be read as GitLab's project N; a test pins that those consumers' schemas refuse every
  job from here. `headRepositoryId` is there so a consumer can refuse a pull request from a fork.
- **All of them are consumed:** `workflow_run`, `workflow_job` and `deployment_review` (FRG-22, below),
  `pull_request` and `issue_comment` (FRG-32, below), and `deployment_status` (CLD-10, below).
- **The delivery id is not signed.** A captured delivery could be sent again under a new id and be queued again. Every
  consumer reads the present state from the forge and none acts on the body, so a replay costs a read; keep that true.
- Two connections sharing one webhook secret accept each other's deliveries; give each its own.

### Running the contract on a real repository (FRG-26)

The contract that runs on the mock (`packages/forge/src/github.mock.contract.test.ts`) can be pointed at a sandbox
repository: `packages/forge/src/github.real.contract.test.ts`, off unless `GITHUB_E2E_REPO` is set (the settings and what
it writes are in the README, "GitHub contract against a real repository"). `readGithubE2eConfig`
(`packages/github/src/e2e-config.ts`, `packages/github/src/e2e-config.test.ts`) refuses a half-set configuration by name,
a repository outside `GITHUB_E2E_OWNER`, and a missing `GITHUB_E2E_ALLOW_WRITES=yes`, and never prints the token.

- **Not run.** Nobody has set these against a GitHub yet; that is FRG-27, and it writes to a real service, so it waits for
  you. The three areas it covers are projects, repository and merge requests, the same as the mock run.
- **Not covered by it:** Actions secrets and variables, workflow dispatch, webhooks, collaborator permissions and sign-in.
  Each is tested on the mock only.

## The plan of a run as data

GitHub cannot be handed a generated pipeline, so its stack workflow is a fixed file that reads the run's plan from the
platform (FRG-18). The plan comes from `runPlan` (`packages/iac/src/run-plan.ts`): the stacks in dependency levels and,
for each, the commands, image, runner tags, variables and identity tokens of its jobs. It is read off the same job
objects the GitLab YAML is written from, so the two cannot differ (`run-plan.test.ts` compares every command).

- **Read it:** `GET /organizations/:orgId/projects/:projectId/runs/:runId/plan?action=plan|apply` (default `plan`), with
  the CI token of that project. A person gets 403; the token of another project gets 404.
- **What it holds:** command lines, variable *names and references* (`$CI_JOB_TOKEN`) and identity-token audiences. No
  value. A stored plan is capped at 4 MB.
- **Who stores it:** whoever starts the run (`storeRunPlan` in `@orch/db`, table `run_plans`): `startForgeRun` (FRG-30).
  A pull request's plan and apply store it (FRG-32); a run started any other way still answers 404.
- **Left out:** the manual `import` extra of a DNS zone (GitLab's own button).
- **Shortcut:** the scope is `run.summary`, so any CI job of the project that is in no environment may read any run's
  plan of that project, not only a job of the run.

## The stack workflow on GitHub

`.github/workflows/orch-stacks.yml` (`renderStackWorkflow` in `packages/iac/src/stack-workflow.ts`) is the same file for
every run. A dispatch takes only declared inputs, so it takes the run's id and whether the run plans or applies; the run is named
`orch <run_id> <action>` so the platform can find it.

1. `fetch` mints an Actions identity token, trades it at `POST /auth/ci/exchange` for the platform's CI token, reads the
   run's plan (above) and passes each dependency level on as an output.
2. `level-0` to `level-5` run one matrix job per stack of the level. A level starts when the whole level before it has
   finished (GitLab starts a stack when the stacks it depends on have; a static file cannot have a job per stack).
3. A stack job runs its `plan` and then its `summary` commands with `docker run` in the tool's image, the repository
   mounted, variables passed through an env file and identity tokens minted per job. The summary is posted in the same
   job: no plan is uploaded, because a GitHub artifact is readable by everyone who can read the repository.

- **Refused, naming the stack:** a DNS zone, a cost-gated stack, a stack judged by policy, a stack on a worker pool, a
  stack with an environment, a stack on GitLab's state, and a graph deeper than six levels. A stack that says nothing
  of its state keeps it on the platform.
- **The runner needs** curl, jq and Docker (`ubuntu-latest` has them) and the permission `id-token: write`, which the file
  asks for. Files a container writes are owned by root on a self-hosted runner. A private-registry image cannot be pulled.
- **Not yet working end to end:** the exchange takes GitHub Actions tokens (FRG-23) and counts a job by its workflow run
  (FRG-33), and the onboarding pull request commits the file (FRG-31, below), but it has not run on a real GitHub.
- **Security:** nothing of the dispatch or the plan is written into a script by an expression; values reach it through the
  environment. Any writer of the repository can dispatch it with any run id of the project, so FRG-23 must tie trust to
  the protected branch and the workflow's `job_workflow_ref`, and refuse when a claim is missing.

### The stack workflow in the onboarding pull request (FRG-31)

The pull request that sets up a GitHub project's pipeline also holds `.github/workflows/orch-stacks.yml` when the
project has stacks, in the same commit on the same branch (`orch/pipeline`) as `orch.yml`. Until then nothing wrote the
file, so no dispatch could succeed (`apps/api/src/pipeline-apply.github.test.ts`, `apps/api/src/pipeline.github.test.ts`).

- **Same rules as the pipeline file.** Never a push to the default branch. A repeat is a no-op; a file that differs on the
  default branch (or on the branch) gets a pull request that changes it; both files already in place writes nothing and
  answers `in_place`. A new address or audience rewrites the file in the pull request that is open.
- **It is rendered for this platform.** The file holds the platform's address (`ORCH_API_URL`) and the audience a job asks
  for (`ORCH_CI_AUDIENCE`). A deployment that sets neither delivers the pipeline only, and the pull request says in bold
  that the stack workflow was not added and why. An address that cannot be used is refused with 422 `invalid_pipeline`
  before anything is written.
- **Only GitHub, only with stacks.** A GitLab project has its pipeline from the template, and a project with no stacks gets
  no stack workflow.
- **What it does not do:** the preview and the fleet plan show the pipeline file only, and the fleet upgrade (templates)
  never touches the stack file. The stack workflow has no template version: to change it, change the platform and open the
  pull request again.
- **What ran:** the delivery against the mock GitHub (one pull request with both files, repeat, update, in place, no
  stacks, no platform, bad address), and the pipeline route with and without a platform. **Not run:** a real GitHub, and
  the workflow itself on a runner.

### Deployments on GitHub (CLD-10)

A deployment on GitHub is a request to deploy, with a list of statuses; the platform keeps the newest status as the
deployment's status. `deployment_status` queues the deployment's id only, and `deploymentEventHandler` reads the
deployment and its statuses from GitHub and stores that, so a replayed or reordered delivery does nothing a read would
not (the same rule as a run). **Refresh** (`POST .../deployments/refresh`) reads the newest 100 through the project's
connection, whichever forge it is. Covered by `apps/api/src/deployments.github.test.ts` and
`packages/github/src/deployments.test.ts`; **not run against GitHub**.

- **Ids.** `deployments.gitlab_deployment_id` holds GitHub's deployment id and the API field keeps its name, as
  `projects.gitlab_project_id` holds a repository id: no migration.
- **No run behind it.** `jobId` and `pipelineId` are null on GitHub; the page links the status's `log_url` when it is a
  web address, and nothing else of a status (its description, its creator) is read.
- **Unverified.** The `deployment_status` payload field names, what `log_url` holds when a workflow made the
  deployment, whether statuses come newest first, and how `inactive` is set. Each is a guess from the documentation
  until FRG-27 runs against a real repository.
- **Promote and rollback on GitHub (CLD-11)** dispatch the deploy workflow of a `cloud-run` or `ecs` project and find the
  run by its `run-name` (`deployRunName`); see `docs/deployments.md`.

### Following a run on GitHub (FRG-22)

The two worker handlers that follow GitLab's pipelines (`pipelineEventHandler`, which records every run of a linked
project, and `runEventHandler`, which moves the stacks of a platform run) take GitHub's `workflow_run`, `workflow_job` and
`deployment_review` jobs too. An event only says that something changed: the handlers read the run and its jobs from
GitHub and move each stack to where its job says it is, so a replayed or reordered delivery does nothing a read would
not. Covered by `apps/api/src/runs.github.test.ts`; **not run against GitHub**.

- **A GitHub job is read only as GitHub's.** The job carries the connection, the handlers take the project of that
  connection whose repository has that id (`linkedProjects` with the connection), and a GitLab event is read as GitLab's
  only. A repository's id can never move a GitLab project's run, and the other way round; both are tests. A worker with no
  GitHub opener (`EventDeps.forge`, which `workerForge` fills in `worker-main.ts`) drops a GitHub event with a warning.
- **The state a run is in is `statusOf`'s** (`waiting` and `action_required` are `manual`; see above). An apply job that
  reads `manual` leaves its stack `applying`, as GitLab's `when: manual` does.
- **Waiting for approval has a link.** While a stack is `applying` and its apply job is held for reviewers, the stack
  carries `approvalUrl` (`run_stacks.approval_url`, migration 0063), the job's page in GitHub, and the run's API gives it.
  Every move of the stack drops it, and so does the next event once the job goes on. A page that is not `http(s)` or is
  over 2000 characters is dropped, and the stack waits with no link. **The platform never approves**: it makes no write
  to GitHub for any of this, a test holds the mock to reads only, and the forge's pipelines have nothing to approve with.
  The pull request's note says "waiting for approval in GitHub" with that link (FRG-32); the web will too (FRG-24).
- **Skipped for GitHub:** the secret-detection report of a finished run (a GitLab job's artifact; GitHub has none to read).
  The pull request's note is refreshed after every event of the newest run, as a merge request's is.
- **Limits:** every workflow run of a linked repository is listed with the project's pipelines, not only the platform's;
  no audit event says who approved, because the platform does not know (GitHub does); a read that fails with a 5xx or a
  rate limit fails the job and the queue retries it, while a run GitHub no longer has (404) is dropped. **Not confirmed
  against GitHub:** that it reports a job held for an environment as `waiting`, and the payload of `deployment_review`.

### The apply, and what holds it (FRG-29)

A run dispatched with `action: apply` runs `apply-0` to `apply-5` instead of `level-0` to `level-5`. Each apply job names
the environment `orch-apply`; GitHub holds a job that names an environment with required reviewers until one of them
approves. That approval is the only gate an apply has on GitHub, and the platform only observes it, it never approves.

- **No plan file travels.** A GitHub artifact is readable by everyone who can read the repository, and a plan holds the
  values of secrets. So an apply checks out the commit that was judged (`sha` in the run's plan), plans again, and
  applies that plan only if its changes are the ones the platform judged: the same counts and the same address and
  actions of every resource. The judged changes and the new ones are both read through the summary's filter, so neither
  holds a value. A mismatch stops the job with "Plan again".
- **The environment is checked first.** GitHub makes an environment with no rules the first time a job names one, so
  naming it proves nothing. `requireApplyGate` (`apps/api/src/apply-gate.ts`) reads the environment's rules and refuses
  with `409 apply_not_gated` unless it has a required-reviewers rule with someone in it, or when it is not there, or
  when the token may not read it. The run starter (`startForgeRun`, FRG-30) calls it before it asks for an apply.
- **The apply job is GitLab's**, less the one line that downloads the saved plan, so the two cannot drift: a test holds
  the GitHub job equal to GitLab's with that line removed, and the generator refuses if GitLab's job ever lacks it.
- **One approval per level**, because each apply job names the environment.

Limits, each stated in the code:

- The changes are compared, not the values: a value that changed between the plan and the apply (an input read at plan
  time) is applied. The pin to the judged commit narrows that to inputs outside the repository.
- The compare is per stack, after that stack's own plan. A stack whose plan depends on outputs that an earlier level's
  apply changed in the same run may not match; it fails closed with "Plan again", and a second run settles it.
- No `concurrency` group: two applies of one stack at once are stopped by the state's lock for a stack on the platform's
  state, and by nothing for a stack on a state of its own.
- A reviewer rule removed between the platform's check and the job's start is not seen.
- Which permission reads an environment's rules is not confirmed (the documentation says administration, read); to
  confirm with the real run of FRG-27. Required reviewers on a private repository need GitHub Enterprise.
- The name `orch-apply` is the same for every project. FRG-23 must bind the apply to the environment claim of the
  Actions identity token and to the workflow's ref, because the workflow file is read from the dispatched ref, which a
  writer of the repository could edit.

### Starting a run (FRG-30)

A dispatch answers 204 with no run id, so a run is found afterwards by its name. `startForgeRun`
(`apps/api/src/forge-run.ts`) does the whole start and `forge.startRun` (`@orch/github`, `pipelinesApi`) is the forge's
part of it:

1. A forge that has no `startRun` (GitLab, which is started by a generated pipeline) is refused with `422
   forge_cannot_dispatch`.
2. An apply asks `requireApplyGate` first (FRG-29): `409 apply_not_gated` and nothing else happens.
3. The plan is made with `githubRunPlan`. A stack GitHub cannot run is refused with `422 cannot_generate` and the first
   reasons, each naming the stack. Nothing has been stored or sent.
4. The plan is stored (`run_plans`) **before** the dispatch, so a workflow that starts at once finds it.
5. `startRun` lists the dispatched runs of the workflow, dispatches `{ref, inputs: {run_id, action}}` and nothing else
   (no stack, command or value travels in a dispatch), and looks again for the run that is new and is named
   `orch <run_id> <action>` (`stackRunName`, the same function the workflow file's `run-name` is checked against).
   The list is read first: if it cannot be read the dispatch is not sent, because the run could not be told from
   another.
   - More than one new run with that name is a `conflict` and none is taken. None after the tries is a `timeout`
     whose message says the dispatch was accepted and GitHub may have started the run: the outcome is unknown, so the
     caller must not start another without looking.
   - The wait is 10 looks 1.5 s apart (set by `githubForge(client, {attempts, delayMs})`), and only the newest 100
     dispatched runs are looked at (`shortcut:` in the code).

Not confirmed with real GitHub (FRG-27): that the run's title is `display_title` for a run with a `run-name`, that a
dispatch answers 204 with an empty body, and the two 404 messages of an unprotected branch that mean "no requirement".
The mock is as strict as GitHub is recalled to be about the inputs of a dispatch: an input the file does not declare, a
required one left out and a choice that is not an option are each a 422.

## What is not there yet

A real GitLab run, twice (FRG-8); a real GitHub run (FRG-27); a per-organization GitLab group link on a second
instance; roles for people of a second instance who belong through a parent group only (GitLab's `groups_direct` lists
direct membership alone).

## Pull requests on GitHub (FRG-32)

A pull request is planned and applied through the same consumers as a merge request; the forge decides the details.
`apps/api/src/mr-plan.github.test.ts` runs the whole of it against the GitHub mock.

- **Plan.** `pull_request` `opened`, `reopened` and `synchronize` plan the head commit if no run has: the run, the stored
  plan and a dispatch of `orch-stacks.yml` on the pull request's branch, then one comment that is rewritten as the run
  goes (`**orch plan**`, the same table). **A pull request from a fork is not planned** (`headRepositoryId` is not the
  repository's id, which includes a fork whose repository was deleted) and gets no comment, only a log line: its author
  would control what runs with the project's credentials.
- **Commands.** A new comment that is exactly `orch plan`, `orch apply` or `orch apply <stack>` is a command; an edit,
  talk and a comment of several lines are not. The job reads the comment from GitHub, so its text and author are
  GitHub's own. **The commenter's role comes from GitHub**: `members.accessLevel` of the connection's token on that one
  repository (read/triage reporter, write developer, maintain and admin maintainer), never from the comment and never
  from a platform account. A commenter GitHub does not know has no role and is ignored; one who can read is told when
  they may not. Roles that cannot be read fail the job for a retry, never grant. Planning needs a developer, applying a
  maintainer, as on GitLab. The audit actor is `github_user` with the account's id.
- **Apply.** The same checks as a merge request's (a plan for this commit, an approved pull request that GitHub says is
  mergeable, the secret gate, the apply gate), then the stored apply plan (with the commit and what the platform judged
  of each stack) and a dispatch with `action: apply` on the pull request's branch. The environment `orch-apply` needs
  reviewers, or the apply is refused (FRG-29). If GitHub will not start it the stacks stay planned and nothing is kept
  for the apply. The apply-on-merge setting is not built for GitHub.
- **Shortcuts.** The token needs push access to read a collaborator's permission. A stack that policy, cost, DNS, a
  pool or an `environment` governs is refused on GitHub (the note says so). A plan job posts its summary as the workflow
  run the platform found for the dispatch (FRG-33); one of another run, or an apply run, is refused. If a
  dispatch is accepted but its run is never found, the run is rolled back and the retry dispatches again, so a second
  workflow may start. The plan comment's job link relies on GitHub sending `/runs/<job id>` on to the job (not checked).

### Signing a GitHub Actions job in (FRG-23)

`POST /auth/ci/exchange` takes a token whose `iss` is `https://token.actions.githubusercontent.com`. Only that `iss`
picks GitHub's keys (`/.well-known/jwks`, cached; redirects not followed); the token must then verify against them
(RS256, `aud` is `ORCH_CI_AUDIENCE`, `iss`, `exp`, `nbf`). The project is the one linked to the token's `repository_id`
through a **github.com** connection (`https://github.com` or `https://api.github.com`), found by that and nothing
else: a GitLab project with the same number, a Server connection's repository and another instance are never it. Two
projects for one repository answer 409.

- **Scopes.** `ref_protected` must be `"true"` *and* the `event_name` one of `push`, `workflow_dispatch`, `schedule`,
  `release`, or the job counts as an unprotected ref: no environment, no variables. An absent `ref_protected` fails closed
  the same way. `environment_protected` does not exist on GitHub; an environment is read only from a protected ref.
- **Job identity (FRG-33).** GitHub sends no job id, so the token's `run_id` is stored (`ci_tokens.gitlab_pipeline_id`,
  migration 0064) and stands for the job: leases and state locks are held as `ci:<project>:run-<id>`, and the plan
  summary and policy verdict routes accept a token whose run is one of the stack-run's recorded `plan` runs
  (`run_pipelines`), on the run's ref. The jobs of one workflow run therefore share a lease allowance and a lock, and any
  of them may post any stack's summary: they all come from the generated workflow, which a writer of the repository
  controls anyway. `state.write` and the lease scopes need a protected ref as on GitLab, so a stack on the platform's
  state applies on GitHub only from a protected branch; a pull request's branch reads state and holds no lock. A summary
  posted before the platform has recorded the workflow run is refused (the poll for it is ten tries, 1.5 s apart).
  Upgrade path: the `check_run_id` claim, if GitHub sends it (not confirmed), would give a job of its own.
- **Shortcuts and flags.** The audience is not secret, so the repository binding is the whole control. The environment's
  own protection rules are not read from GitHub. `job_workflow_ref` is not checked. Someone who links another team's
  public repository makes the exchange ambiguous for both (409): a denial, not a way in. `orch ci login` asks the
  runner for the token itself (`ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN`, sent only to a https or loopback address,
  redirects not followed).

### The screens on GitHub (FRG-24)

The web reads `forge` and `capabilities` from each project (`GET /organizations/:org/projects`), so a screen asks the
project, not the connection, what it can do.

- **Connect.** Settings → Connections and the first step of the import offer one form: a Forge selector (GitLab or
  GitHub), the address (`https://github.com` is the default for GitHub; `https://gitlab.com` for GitLab; changing the
  forge swaps a default but never what was typed), and the token. The token is cleared once it is sent and no page
  shows it back. The connections table has a Forge column.
- **Import by address.** Above the list, "Repository address" takes a pasted web address. The connection whose
  address has the same host (`api.` is dropped, so `https://api.github.com` and `https://github.com` are one) takes
  over the import card, searches for the repository and ticks it once; an untick sticks. GitHub's path is the first two
  segments (`acme/web` out of `acme/web/tree/main`), GitLab's is everything before `/-/`. An address that is no web
  address, or reaches no connection of the organization, says so under the field.
- **One line per capability flag a screen uses.** A control the forge cannot honour is replaced by the reason, not
  disabled without a word:

  | Flag | Screen | On GitHub |
  |---|---|---|
  | `ciLint` | Pipeline review | "GitHub does not check a workflow before it is merged, so the review cannot lint it." The heading says Notes, not "lint warns"; the diff names `.github/workflows/orch.yml` |
  | `deployments` | Status → Deployments | true on GitHub since CLD-10: the card reads in GitHub's words and refreshes; a forge that lacked the flag would show the reason in its place |
  | `runners` | Settings → Pools, health check | the reason, in place of the Check button |

  The pipeline wizard offers only the connections of the project's forge. The other flags (`approvalState` aside)
  have no screen that uses them yet, so there is no control to hide for them.
- **Shortcuts.**
  - The address box takes web addresses only: `git@host:path` is not read, and a GitLab served from a sub-path is
    not matched. It finds on a button ("Find"), not while typing.
  - The wizard still says "merge request" for a pull request; a GitHub project's note and file name are right.
  - The web's file names (`FORGES.*.file`) repeat `pipelineFileOf` in the API; the journey test checks that the
    file it names is the one on the pull request's branch.
  - The pools health check uses the organization's first GitLab connection; the pool page's text still talks about
    GitLab runners. The organization pages still say "linked to a GitLab group", and the sync target type is labelled
    "GitLab CI/CD variables". The connection test result still reads GitLab's reply.
  - The web tests reach the GitHub mock through the workspace packages `@orch/github` and `@orch/forge`, added as
    devDependencies of `apps/web` (nothing in the shipped bundle).

### Signing in with GitHub (FRG-25)

`GET /auth/github/login` and `/auth/github/callback` (`apps/api/src/routes/github-login.ts`). The same shape as the
GitLab sign-in: authorization code with `state` and a PKCE challenge (S256), in a 10-minute `HttpOnly` cookie that
only the browser that started the sign-in carries. The scope is `read:user`. The access token answers "who is this"
once and is dropped; nothing stores it.

| Setting | Meaning |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | the GitHub OAuth app (Settings → Developer settings → OAuth Apps) |
| `GITHUB_OAUTH_REDIRECT_URI` | `https://<host>/auth/github/callback`; https, or http on loopback only, and exactly that path |

All three or none. GitHub sign-in needs `ORCH_MASTER_KEYS`, because the roles are read with the tokens of the
organization's GitHub connections; without them it stays off and the API logs why. It is also off in development
sign-in mode. It works without the GitLab settings.

- **A person is a GitHub user id.** Never the login (which GitHub lets a person change and hand to another) and never
  an email. A first sign-in makes a person with no GitLab id; a later one finds them and refreshes their name. A
  GitHub identity is never matched to an existing person, so signing in with GitHub cannot take over a GitLab account.
- **A session needs a role.** After the code is exchanged the platform asks, for every project linked to a github.com
  connection, what the user may do in the repository (collaborator permission: read and triage are Reporter, write is
  Developer, maintain and admin are Maintainer, as in the table above) and gives the highest. A user with no role anywhere gets `403
  no_access` and nobody is made. Their GitHub id is logged (not the code, not the token).
- **Organization roles too, when the organization is linked to a GitHub organization** ([below](#an-organization-on-github-frg-34)).
  A person with no repository role but an owner's or member's seat in a linked GitHub organization signs in; a person
  on the platform-administrator list for GitHub signs in with no role at all.
- **Failures.** GitHub unreachable or rate-limited: 502. A code GitHub refuses, a spent code, or a person who
  turned it down: 401. A refused client secret is also logged at error level (the deployment's fault). Roles that
  could not be read, e.g. a connection token GitHub now refuses: 503 and no session, never a guess.
- **The identity is the account's own.** It is listed in the "Sign-in methods" card and cannot be removed (409).
- **Cost.** About three GitHub calls per linked repository per person, cached for five minutes (as the GitLab roles
  are); a failed lookup is never cached.

What ran: the flow against the GitHub mock, with its OAuth endpoints answering the way GitHub's documentation says
(HTTP 200 with an `error` body on a failed exchange). `apps/api/src/github-login.test.ts` covers a good flow, a
replayed, different, expired and cookie-less state, a thief holding the cookie and a spent code, a person who is not a
collaborator, a refused client secret, GitHub down, roles unavailable, and a leak check over responses, headers, logs,
audit, identities, users and sessions for the client secret, the connection token, the code, the verifier and every
access token issued.

**Not run against GitHub.** PKCE for an OAuth app is taken from GitHub's changelog of 2025-07-14 (S256, and the
client secret is still sent); it was not tried against a real app. github.com only: a GitHub Enterprise Server
connection's repositories give no role here, and the settings carry no base URL.

### An organization on GitHub (FRG-34)

> **An auth-model change.** It adds a second way to become an organization owner, and a second list of platform
> administrators. Read it before turning it on; `/security-review` of it is logged in `.claude/.planning/25-multi-forge/LOG.md`.

An organization is made with `githubOrgId`: the GitHub **account id** of an organization (`https://api.github.com/orgs/<login>`,
field `id`; never the login, which GitHub lets be changed and handed on). Like the slug and the GitLab group it is fixed at
creation, one GitHub organization belongs to one organization here (`409 github_org_linked` otherwise), and the web form
asks for a GitLab group, a GitHub organization or both.

| Setting | Meaning |
|---|---|
| `GITHUB_MEMBERSHIP_TOKEN` | a token with `read:org`, owned by a member of every linked GitHub organization; needs the three `GITHUB_OAUTH_*` settings |
| `ORCH_PLATFORM_ADMIN_GITHUB_IDS` | GitHub user ids that may create organizations; a list of its own |

- **Why a deployment token and not a connection's.** A new organization has no connection yet to read its membership with.
  The token is read from the environment, never stored or shown, and is the only secret FRG-34 adds.
- **Roles.** An owner of the GitHub organization is an owner here, an active member a member. A billing manager, an
  invitation not yet accepted, and anyone else hold nothing. Where GitLab or single sign-in also speak, the highest role
  holds. It is read with the same five-minute cache as the repository roles, and a lookup that fails is a 503, never a guess.
- **Platform administrators.** `ORCH_PLATFORM_ADMIN_GITHUB_IDS` is checked against the GitHub user id of the person who
  signed in with GitHub; `ORCH_PLATFORM_ADMIN_GITLAB_IDS` against a GitLab id. A GitLab user with the same number is not an
  administrator through the GitHub list, and the reverse. Such a person signs in with no role (there may be no organization yet)
  and can then make the first one.
- **Audited.** `organization.create` records `githubOrgId` next to `gitlabGroupId`.

**Not run against GitHub.** The membership route is taken from GitHub's documentation (`GET /orgs/{org}/memberships/{user}`:
`state` and `role`) and the `read:org` scope from the same page; it was run only against the mock. Which token types
GitHub accepts for it, and what an organization that restricts third-party access does to it, were not tried.
