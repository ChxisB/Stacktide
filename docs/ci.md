# Using Orchastrature from a GitLab CI job

A job proves who it is with a GitLab `id_token`, trades it for a token that lasts 15 minutes at most,
and then runs its commands with the variables of the environment it deploys to. Nothing is stored:
no token variable in GitLab, nothing written to disk by `orch`.

## What the platform needs

- `ORCH_CI_AUDIENCE` on the API: the `aud` the jobs ask for (for example `orch.example.com`). Without it
  the exchange answers 503 `ci_unavailable`.
- The GitLab project is registered in the platform (its `gitlab_project_id` is how the job is found), and
  the job's `environment:` name is the **slug** of an environment of that project.
- **More than one GitLab.** A token is checked against the GitLab that issued it, and reaches only that
  instance's projects, so project 42 of two instances are two projects. The deployment's own GitLab is
  `GITLAB_URL` (still required, as `ORCH_CI_AUDIENCE` is checked against it); a token of any other GitLab
  is accepted only when a GitLab connection is registered at exactly that address (the token's `iss`, no
  trailing slash), and its keys are fetched from that connection's address. A project imported through a
  connection belongs to it; a project linked before connections existed belongs to `GITLAB_URL`'s GitLab.
  An address nobody registered is refused without any request to it.

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

## GitHub Actions

A job of a repository on **github.com** signs in the same way, with the identity token the runner gives it.

- The repository is linked to a project through a github.com GitHub connection; the repository's id (`repository_id`
  in the token) is how the job is found. A repository of a GitHub Enterprise Server, or of an Enterprise Cloud
  organization with its own subdomain, is not supported. A repository nobody linked is refused; one linked twice
  (two organizations linked the same public repository) is refused as ambiguous.
- The workflow needs the permission `id-token: write`. `orch ci login` then asks the runner for the token itself, for the
  audience you give it with `--audience` or `ORCH_AUDIENCE`: the API's `ORCH_CI_AUDIENCE`. The audience is not a secret on
  GitHub, so the repository binding is what keeps another repository out.

```yaml
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging             # the slug of an environment in the platform; optional
    env:
      ORCH_API_URL: https://orch.example.com
      ORCH_AUDIENCE: orch.example.com
    steps:
      - run: |
          login="$(orch ci login)"
          eval "$login"
          orch run -- ./deploy.sh
```

What differs from GitLab: GitHub's token has no job id and no word on whether an environment has protection rules. The
token reads the project's environment (its variables, secrets included) only from a ref GitHub says is protected
(`ref_protected`) **and** a run started by `push`, `workflow_dispatch`, `schedule` or `release`: a pull request, a fork's
included, never counts. A token that does not say so gets the project scopes only. With no job id, the token's
**workflow run** (`run_id`) stands for the job (FRG-33): a lease or a state lock is held by the run, so the jobs of one run
share them (and their lease allowance), and a plan summary or policy verdict is accepted from a job whose run is one
of the stack-run's `plan` runs, on its ref. A protected ref gets the lease scopes and `state.write` as on GitLab; an
unprotected one (a pull request's branch) gets neither, and `--state` gives it a read-only state token. A token
with no `run_id` gets the project scopes only. The workflow file itself (`job_workflow_ref`) is not checked: anyone who
may push to a protected branch can run a workflow there.

## What the token can do

Only this, and only for the job's project and environment:

| | |
|---|---|
| read the project | `project.read` |
| post the plan summary, or the policy verdict, of an IaC run's stack (a job with no environment) | `run.summary` (audited as the CI job, as `run.summary` or `run.policy`) |
| read the environment | `environment.read` |
| read the environment's variables, secrets included | `secret.reveal` (audited as the CI job) |

It cannot list other environments, change anything, or create tokens. A job in a **protected**
environment (or one GitLab does not say is unprotected) is only signed in from a **protected ref**.
A job with no `environment:` gets a token for the project only, which cannot read variables. It can post a
plan summary (counts and resource addresses, never values) for one stack of one run, and only from the job
the platform recorded as that stack's summary job, on the run's own ref.

`orch run` does not pass `ORCH_TOKEN` or `ORCH_ID_TOKEN` on to the command it starts (the id_token can be traded for a new token until it expires). An id_token under another name (`--id-token-env`) is not held back.

## Variables for Terraform: `--prefix`

`orch run --prefix TF_VAR_ -- terraform plan` hands each variable on as `TF_VAR_<NAME>` instead of
`<NAME>`, which is how Terraform reads its input variables from the environment. Only the prefixed names
are set from the platform (the parent's other variables, a `TF_VAR_*` among them, pass through as they are). The prefix is the start of an
environment variable name: letters, digits and `_`, not starting with a digit, at most 64 characters.
The generated plan jobs of a stack with an `environment` do this for you (`docs/iac.md`).

## Terraform state: `--state`

A stack that keeps its state on the platform (`state: orch` in `stack.yml`, ADR-0017; the generated jobs do all of what
follows, see `docs/iac.md`) reaches it with a token of its own:
`orch ci login --state` prints `ORCH_STATE_TOKEN` instead of `ORCH_TOKEN`, and the token is tied to no environment.
It can read state (`state.read`), and **only a job on a protected ref** can also write and delete it (`state.write`),
so a job on a branch anyone can push to reads state but cannot change it. It lasts as long as the job, up to one
hour, which is why those jobs set `timeout: 1h`.

Terraform's `http` backend sends Basic credentials, so the state routes (and only they) take this token as the
password. Any user name will do:

```
TF_HTTP_ADDRESS=$ORCH_API_URL/organizations/$ORCH_ORG/projects/$ORCH_PROJECT/state/<stack>
TF_HTTP_USERNAME=ci
TF_HTTP_PASSWORD=$ORCH_STATE_TOKEN
```

`GET` reads the newest version (404 when there is none), `POST` stores the next one, `DELETE` removes them all. A
person, whether signed in or holding an API token, gets 403: state holds secrets in clear, so its content goes to the
job and to nobody who holds a role. A write is refused with 409 for a serial below the stored one, another lineage,
or the stored serial with other content, and with 413 over the body cap. The platform keeps the newest 20 versions.
A project that still holds state cannot be deleted (409 `project_has_state`): delete the state first.

### What a state holds: the resource index

Every write also records **which resources the state holds**, by name only, in the same transaction as the version
(so the list always describes the newest version; a state it cannot list is refused with 422 `invalid_state` and
nothing is stored). A person with the project role reporter or above, or an organization admin, reads it:

```
GET /organizations/<org>/projects/<project>/state/<stack>/resources
    ?type=aws_route53_zone&provider=registry.terraform.io/hashicorp/aws&module=module.net&limit=50&cursor=...
```

Each item is `address`, `mode` (`managed` or `data`), `type`, `name`, `provider` (the registry address, without the
alias), `module` (`null` at the root) and `indexKey` (the `count` or `for_each` key of an instance, else `null`),
in address order. A filter is an **exact value**, not a pattern or a prefix: `module=module.net` does not include
`module.net.module.sub`, and `module=` (empty) is the root module. A stack with no state, or whose state was
deleted, lists nothing. The list is the identity of the resources and nothing from inside them: no attribute, no
output and no private data is copied, so reading it cannot show a secret that is in the state.

Two things to know. A `for_each` key is part of an address, and it is a name your configuration chose: a
configuration that builds its keys from secret values would put those in the list, so keep secrets out of keys. And
the index holds at most 100,000 instances: a state with more is refused (422), not cut short.

### Looking at a state: `orch state ls`, `orch state resources` and the State page

A person with the project role reporter or above (an organization viewer included) or an organization admin can see
**which versions a stack has and what the newest one holds, by name**, and never the state itself. Nobody who holds a
role can read or change a state's content; only the job can.

```
orch state ls <stack> --org <org> --project <project>
orch state resources <stack> [--type <t>] [--provider <p>] [--module <m>] --org <org> --project <project>
GET /organizations/<org>/projects/<project>/state/<stack>/versions
```

`ls` prints one line per version, newest first: serial, when it was written, its size and who wrote it (`ci:job-<id>`,
or `import:user:<id>` for an import). `resources` prints the addresses, with the same exact filters as the API above
(`--module=` is the root module). `--json` gives the whole items. The versions list is not paged: the platform keeps
the newest 20. The **State** page of the web app shows the same two lists for the stack name you type in, read-only:
no download, edit or rollback. A resource address and a lineage are text a job wrote, so the CLI blanks control
characters in an address before it reaches your terminal.

### Moving a stack from GitLab's state: `orch state import`

A stack that has state in GitLab (the default) and is to keep it on the platform needs that state copied first;
switching `state: orch` alone starts it from nothing (`docs/iac.md`). A project maintainer, or an organization admin,
copies it:

```
orch state import <stack> --org <org> --project <project> [--connection <name>] [--yes]
POST /organizations/<org>/projects/<project>/state/<stack>/import      {"connectionId": "<id>"}
```

The platform reads the state through the organization's GitLab connection (`GET .../terraform/state/<stack>` of the
project, which GitLab answers to a token with the Maintainer role; the stack's name is the state's name, as the
generated jobs use it), checks it is Terraform state (version 4), and keeps it as the stack's **first version**, at
its own serial and lineage, byte for byte, with the resource index. Nothing is written to GitLab and nothing there is
removed. Answer 201: `serial`, `lineage`, `sizeBytes`, `resources`. A person is never handed the state: the platform
reads it, and an audit event `state.import` records who, the stack, the serial and the size, never what is inside.

- **It fills an empty stack, nothing else.** A stack that has any version answers 409 `not_empty`, and GitLab is not
  asked. Of two imports at once exactly one is kept. To import again, delete the state first (`DELETE` as a job on a
  protected ref).
- **It is a copy, taken once.** Stop the applies of the stack that still use GitLab's state before you import, and do not
  run one after: a change applied there is not in the copy, and the next apply with `state: orch` would plan from
  state that is behind. The import does **not** switch the stack: set `state: orch` in `stack.yml` in a merge request,
  as any change to the repository.
- **Refused with nothing kept:** a stack the scan does not list (403 `unknown_stack`), a project not linked to GitLab
  (422 `project_unlinked`), no state of that name in GitLab (404 `state_not_found`; GitLab answers 404 for a project the
  token cannot see too), a document that is not state (422 `invalid_state`, its text not repeated), more than 16 MiB
  (413), a lock held on the stack (423), a connection that is not the organization's GitLab one (404, 422), and
  GitLab refusing the token or failing (502 `gitlab_failed`, in fixed words).
- The CLI asks for confirmation before it copies (`--yes` for scripts), prints what it kept, and says on stderr what is
  left to do.

Not verified: against a real GitLab. The endpoint, its token and the Maintainer role are taken from GitLab's
documentation and exercised only against the mock. The first real import of a stack is yours to run and check
(`orch state import`, then a `plan` with `state: orch` that should show no changes).

### Locks

A stack has one lock. Terraform's backend takes it with `LOCK` and releases it with `UNLOCK` on the state address
(its default verbs). If a proxy in front of the API does not carry custom verbs, point the backend at the lock
address instead and use `POST` and `DELETE` there:

```
TF_HTTP_LOCK_ADDRESS=$TF_HTTP_ADDRESS/lock    TF_HTTP_LOCK_METHOD=POST
TF_HTTP_UNLOCK_ADDRESS=$TF_HTTP_ADDRESS/lock  TF_HTTP_UNLOCK_METHOD=DELETE
```

Only a job that may write (a protected ref, `state.write`) takes a lock. A second job is answered `423` with the
holder's lock info (`ID`, `Who`, `Operation`, ...), which Terraform prints. While a lock is held only its holder
writes, naming the lock in `?ID=`; reading is never held off. A lock is the job's: another job cannot release it,
even knowing its ID, and the holder releases it only with its ID.

A lock ends when the job's token does (up to one hour), so a crashed job does not hold a stack for long. To end one
sooner, an organization admin calls `POST /organizations/<org>/projects/<project>/state/<stack>/force-unlock` with
a session or an API token; it answers `{"released": true|false}` and is audited with the lock's ID and owner.

A state larger than `ORCH_MAX_BODY_BYTES` (2 MiB by default, `docs/hardening.md`) is refused until the operator
raises it; the repository itself stores up to 16 MiB.

## Options

- `orch run --prefix <PREFIX>`: name every variable `<PREFIX><NAME>` for the command.
- `orch run|pull|export|push --folder <path>`: the one folder of the project's variables to read or write (default `/`, the root). An environment variable is flat, so a command holds one folder at a time and never its subfolders; inside it `${KEY}` is that folder's key and `${/path/KEY}` reaches another folder's.
- `orch folders list|create|rm [<path>]`: the project's folders (`--org`, `--project`). A folder is removed only when nothing is in it.
- `orch ci login --api-url <url>`: instead of `ORCH_API_URL`.
- `orch ci login --id-token-env NAME`: when the `id_tokens:` entry is not called `ORCH_ID_TOKEN`.
- `orch ci login --state`: a token for Terraform state alone (below).
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
