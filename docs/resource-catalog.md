# Resource catalog (BLP-1 to BLP-20)

A **resource** is something your app needs, picked from a short list: a network, a container service, a Postgres, a bucket,
on GCP or AWS. You ask for one with `orch resource add` (or the API) and the platform opens **one merge request (GitLab) or
pull request (GitHub)** that holds the Terraform for it. Applying it is the flow the project already has: plan, policy, cost,
approval, apply, drift. [ADR-0024](adr/0024-blueprints.md) (Proposed) records the decision; the facts about each cloud
service are in [blueprints-spike.md](blueprints-spike.md).

> **Nothing here has been applied in a real cloud.** The modules are tested by reading their files and by an opt-in
> `terraform validate`. The first real apply of all eight is BLP-21, a task for a person with a sandbox GCP project and AWS
> account. Until it is done, read each module's README and the plan before you merge.

## What it does and does not do

| It does | It does not |
|---|---|
| Write `stack.yml`, `main.tf`, a README and the vendored module into your repository, as a request | Call a cloud, an SSH host or a container runtime: the platform holds no cloud credential, the CI runner does |
| Check every input against a closed schema, and every `uses` against the project's other resources | Take a secret, a password or a free-text value anywhere: a database password is made by Terraform and kept in Secret Manager or Secrets Manager |
| Keep a record of what was asked for and the request that carries it | Store what exists: a resource's **state** is read from its stack's runs each time |
| Show the `url` and `console_url` a plan summary carried | Delete anything: removing a resource is a removal request and a destroy run (feature 34), and delete is opt-in there |
| Work the same on GitLab and GitHub | Support a network made some other way (by id), GKE or EKS, Azure, `redis`, queues or a CDN: backlog |

## The kinds

| Kind | GCP | AWS | Uses |
|---|---|---|---|
| `network` | VPC, subnet, direct VPC egress, private service access | VPC, public and private subnets in two zones, NAT, a default security group with no ingress | nothing |
| `service` | Cloud Run v2 service, an Artifact Registry repository, a service account | ECS Fargate behind an HTTPS-only ALB, an ECR repository, task and execution roles, CloudWatch logs | `network`, `postgres`, `bucket` |
| `postgres` | Cloud SQL, private IP only, backups, deletion protection | RDS, private subnets, backups, encrypted, deletion protection | `network` |
| `bucket` | GCS, uniform access, public access prevention enforced | S3, all four public-access blocks, default encryption | nothing |

**Idle cost** is what each costs while nothing uses it. It is written once, in each module's README, and `orch resource
blueprints` and the API read it from there.

| | GCP | AWS |
|---|---|---|
| `network` | none (traffic is not free) | the NAT gateway, about 32 USD a month plus per GB |
| `service` | none at the `small` profile; `medium` and `large` keep instances running | the load balancer (about 17 USD a month) and the tasks (`small`: about 9 USD a month); Fargate does not scale to zero here |
| `postgres` | the instance, all the time (`small` is a few USD a month; `medium` and `large` tens to hundreds), plus storage and backups | the instance (`small` about 12 USD a month, more for the others), plus storage, backups and the secret |
| `bucket` | what is stored | what is stored |

Prices are the modules' own estimates for `us-east-1` and move; the cost estimate of feature 16 shows the real figure for a
GitLab project, and **GitHub has no cost estimate**.

## Ask for one

```bash
orch resource blueprints                       # kinds, clouds, versions, idle costs
orch resource add network  --env staging --cloud gcp --name main --region us-central1 --gcp-project my-proj-1234
orch resource add postgres --env staging --cloud gcp --name main --region us-central1 --gcp-project my-proj-1234 \
  --uses network:main
orch resource add service  --env staging --cloud gcp --name api  --region us-central1 --gcp-project my-proj-1234 \
  --uses network:main --uses postgres:main --port 3000 --public false
orch resource add bucket   --env staging --cloud gcp --name files --region us-central1 --gcp-project my-proj-1234 --dry-run
orch resource ls --env staging
orch resource show staging-api-service
orch resource change staging-files-bucket --versioning true
```

* `--dry-run` asks the API what the request would hold (the verb, the stack, the file list and the idle cost) and writes
  nothing: no branch, no request, no record, no audit event. It applies the same checks as a real request.
* `--json` is on every step and prints the API's answer.
* A mistake in the words (an unknown kind or cloud, a missing flag, a flag that belongs to another kind, a bad `--port`,
  `--profile` or `true|false`) exits with 2 before the API is asked. A refusal of the values (a region that is not a region,
  a `uses` that names nothing) comes from the API and names the key.
* A second `add` for the same environment, kind and name changes the same request. The same resource cannot move to the other
  cloud (409) and cannot be renamed or change kind (422): ask for a new one.
* `--uses` replaces the list on a `change` and cannot empty it; to drop a dependency, edit the request.

The API is `POST /organizations/:orgId/projects/:projectId/resources` (add), `PATCH …/resources/:id` (change), `POST
…/resources/preview` (what a request would hold), `GET …/resources` and `GET …/resources/:id`, and `GET /blueprints` (the
catalog, for any signed-in caller). Adding and changing need the project's **maintainer** role and are audited as
`resource.propose` with the kind, cloud, name and file list, never the files' text; reading needs **reporter**.

## What is written

For `orch resource add bucket --env staging --name files`, in one request on the branch `orch/resource-staging-files-bucket`
(never the default branch):

```
infra/staging/files-bucket/stack.yml      tool: terraform, name staging-files-bucket, depends_on from uses
infra/staging/files-bucket/main.tf        backend "http" {} and one module call, values as escaped literals
infra/staging/files-bucket/README.md
infra/_blueprints/gcp/bucket-v1/…         the module, once per repository; a new version is a new directory
```

`state` is `gitlab` on GitLab and `orch` on GitHub (GitLab-managed state is refused there); both are wired by the pipeline the
project already has ([iac.md](iac.md)). A project with no stack pipeline yet is refused with a sentence: set that up first.
On GitHub the request also notes when the stack workflow file is missing.

## Wiring

By **names**, not by state. `service.uses = ["postgres:main"]` adds `depends_on` and the name of the secret the database
module creates (`<environment>-main-database-url`); the service's identity is granted that secret and nothing else, and the
cloud mounts it. A bucket `files` is the variable `BUCKET_FILES`. The platform never sees a value.

The request is refused, by name, when a `uses` names an unknown resource, one on another cloud, one in another environment,
a second network, or a database on a different network from the service's. No kind can use one that reaches it back, so a
cycle cannot be written. An AWS service needs a network and a certificate (the load balancer serves HTTPS only); a GCP one takes no
certificate, since Cloud Run serves HTTPS itself.

## The inputs are closed

Every input goes through one strict schema, and values reach the files only through it, as escaped literals:

| Input | Rule |
|---|---|
| `environment`, `name` | lowercase letters, digits and single dashes, starting with a letter, at most 12 characters each |
| `cloud` | `gcp` or `aws` |
| `region` | a GCP region like `us-central1`, an AWS region like `eu-west-2` |
| `project` | GCP only: a project id. An AWS account is the runner's credential, not an input |
| `profile` | `small`, `medium` or `large`: a reviewed table to machine, instance or CPU and memory, never typed by hand |
| `uses` | up to 8 of `kind:name`, in the same environment and cloud |
| `cidr` (network) | a private IPv4 range from /16 to /24 (default `10.20.0.0/16`) |
| `image`, `port`, `public` (service) | an image reference without credentials; 1 to 65535 (default 8080); `public` is off unless asked |
| `certificateArn` (service, AWS) | an ACM certificate ARN, required |
| `version` (postgres) | `15`, `16` or `17` (default `16`) |
| `versioning` (bucket) | on or off (default off) |

A quote, a newline, `${`, `%{` or a backslash in any field is refused, and a test passes each through every field of every
kind. Anything else is an unknown key and a 422.

## Safe by default

Not options: a database is private with deletion protection and backups on; a bucket is private and encrypted; a service
takes no unauthenticated traffic unless `public: true`, and its identity holds only the secrets and buckets it uses; no role
has a `*` action or resource; no security group allows ingress from everywhere except the HTTPS rule behind `public`. Tests
read every module and fail on each of these. A policy set of your own still runs on the plan in your pipeline.

## Links on the page

A plan summary may carry two outputs, and only these two: `url` and `console_url`, each a non-sensitive `http(s)` string of
printable ASCII, at most 300 characters, and only from a job on a protected ref. The summary job drops everything else, a
sensitive output and a long one included (a test proves both). The newest plan decides what the resource shows; a stack that
was destroyed shows none.

## Why this is not Coolify

[Coolify](https://github.com/coollabsio/coolify) and [Dokploy](https://github.com/dokploy/dokploy) install on a server and run
your apps in Docker on it, so they hold access to your servers. This platform holds no cloud or server credential (decision
D1 and invariant 3 do not change). What is kept from them is the shape of the product: an app, its database, a bucket, one
place to see them. What differs: a resource here is a **managed cloud service in your own account** (Cloud Run, Cloud SQL, S3),
every change is a **reviewed request**, and the credential stays on your CI runner. There is no catalog of 360 apps, no build
pack (your Dockerfile builds) and no runtime of ours: the catalog is four kinds on purpose, since each is a promise to keep up
with a provider.

## Not done yet

* **BLP-21**, the first real apply of each module (a human gate). Costs, timings and any difference go into
  [blueprints-spike.md](blueprints-spike.md).
* **Deploying** an app onto a service: feature 36. A service runs a placeholder image until then.
* **One page** that shows and manages all of it: feature 37. There is no resource screen yet; the demo has one resource of
  each kind (`bun run demo`, [demo.md](demo.md)) that the API and CLI list.
* A request whose files have already reached the default branch keeps an open request open if the inputs are reverted; a
  forge call per file is made one at a time. Both are follow-ups.
