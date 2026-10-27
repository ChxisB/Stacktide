# 33 Elastic runners - Spec
Prefix: ELR · Milestone: M5 · Status: planned 2026-10-23, waiting for your go (no product code written) · Needs: 06, 09, 16, 19, 25 · Came from: "We want to have runners automatically spin up and down, we need pipelines to be super light and performant. Can we spin up runners and spin down on the fly for GitLab on GCP and AWS" (2026-10-23, with four links: gitlab-runner, fleeting, actions-runner-controller, GARM); then "I want the ability for this to work with GitHub or GitLab" (2026-10-23), which brings GitHub fleets in (cut E)

## Goal
An organization gets a runner fleet in its **own AWS or GCP account** that is empty when nothing runs, adds one fresh instance per job, and goes back to empty. The platform makes the fleet something you choose on a worker pool, writes its Terraform as a merge request, and keeps the pipelines it generates small enough that a cold instance per job is not slow.

**Can we? Yes, and GitLab already does the spinning.** The Docker Autoscaler executor with a fleeting plugin (AWS, Google Cloud, Azure) creates an instance for a job and deletes it after. With `capacity_per_instance = 1` and `max_use_count = 1`, "the instance it was executed on is immediately deleted". It has been GA since GitLab Runner 17.1. We do not build a scheduler or cloud adapters. We build the part around it that nothing else gives this platform: the fleet as a pool setting, its infrastructure as a reviewed stack, and lighter generated pipelines.

**On GitHub the same goal is met by GARM** (cut E): a small manager in the org's own cloud that creates a fresh VM when a GitHub Actions job is queued for a pool's label and deletes it after. The platform again only holds the setting and proposes the Terraform as a **pull request**. This needs two edits to what is built: the stack workflow on GitHub must take `runs-on` from the run's plan data (today it is fixed in the file), and ADR-0019's refusal of worker pools on GitHub is lifted (ELR-1).

## What I read (2026-10-23)
Your pasted text came from a chat assistant, so I checked the claims that carry weight against upstream.

| Claim | Result |
|---|---|
| Autoscaling for AWS and GCP through GitLab Runner and fleeting plugins | **Confirmed** ([docker autoscaler](https://docs.gitlab.com/runner/executors/docker_autoscaler/)): plugins for AWS, Google Cloud, Azure; `gitlab-runner fleeting install` from 16.11; GA since 17.1 (experiment 15.11, beta 16.6) |
| One instance per job, deleted after | **Confirmed** for `max_use_count = 1`; the page describes only that case |
| Scale to zero | **Partly.** The runner manager (a VM) must stay up and "must not be a spot instance"; instances scale to zero. The page recommends at least two managers sharing tags for fault tolerance |
| Cloud autoscaling must be switched off | **Confirmed**: the runner owns the scaling; AWS scaling policy `none`, scale-in protection on, `AZRebalance` off (else "context deadline exceeded"); Azure overprovisioning off; **Google Cloud: multi-zone instance groups are not supported**; one dedicated group per runner entry |
| Docker Machine is the old way | **Confirmed**: deprecated in 17.5, removal scheduled for 20.0 (May 2027). Not used here |
| GitLab has a Terraform kit for this | **Found**: GRIT, "a library of Terraform modules", marked **experimental**, with an AWS `docker-autoscaler-default` module (1 to 5 VMs in a new group and VPC, `min_support` required). I did not read its GCP modules |
| ARC and GARM | **GARM** (README read): GitHub and Gitea only, no GitLab, Apache-2.0, pools matched by label from `workflow_job` webhooks, providers are external executables, scale-to-zero. **ARC** ([README read 2026-10-23](https://github.com/actions/actions-runner-controller)): Apache-2.0, a Kubernetes operator with runner scale sets installed by Helm, "controlled runners can be ephemeral and based on containers"; the older autoscaling modes are legacy and "maintained by the community only"; scale-to-zero, GKE/EKS and GHES support are **not stated**. Neither runs GitLab jobs. **GARM is the GitHub fleet in this plan; ARC is not**, because it needs a Kubernetes cluster the org would have to run (question 7) |
| GARM's AWS and GCP providers, GitHub authentication, whether `runs-on` can come from matrix data | **Not read.** The chat says GARM supports AWS and GCP; the README I read lists external providers. ELR-4 verifies the two providers, how GARM authenticates to GitHub, and the `runs-on` question |
| Not read | the `[runners.autoscaler]` page itself (the docs.gitlab.com page I fetched was the old Docker Machine one), `instance_ready_command`, policy `periods`/`timezone`/`scale_factor`, `[runners.cache]` for S3 and GCS, the `gitlab_user_runner` Terraform resource and the `create_runner` token scope. ELR-4 verifies each before anything is built on it |

## Scope
A) A decision (ADR-0022). B) A `fleet` setting on a pool. C) Terraform for the fleet, per cloud, rendered and proposed as a merge request. D) Lighter generated pipelines, measured first. E) CLI, settings, docs.

## Non-goals
- **Our own scheduler or cloud provider adapters** (the chat's "unified runner API above provider adapters"). It would put cloud credentials in the control plane (invariant 3) and a second execution path beside GitLab CI (D1, ADR-0015 option b). Not now; ELR-1 records why.
- Provisioning from the platform: the platform makes no cloud call. The org's own CI applies the stack, as for any stack.
- ARC (a Kubernetes operator) and GitLab's Kubernetes executor (a pod per job on GKE or EKS). Backlog; both need a cluster. GARM, for GitHub, is **in** (cut E).
- Spot or preemptible job instances: an interrupted `apply` leaves state locked and infrastructure half changed. Not offered.
- Windows, macOS and GPU profiles (docs only), Azure, runner registration tokens, and anything that shows a runner's address or token.

## Design
**Who does what**

| Piece | Runs | Holds |
|---|---|---|
| The platform | control plane | the fleet's settings (no secret) and nothing else; **no cloud credential, no runner token** |
| The fleet stack (Terraform) | the org's own CI runner, planned and applied like any stack | creates the manager, the scaling group, the roles, the cache bucket, the runner |
| The runner manager | one small non-spot VM in the org's cloud | the runner token, kept in the cloud's secret store; a role that may only resize its own group |
| Job instances | created by the manager for one job, deleted after | **no role by default**; jobs reach the cloud by OIDC, as today |

**The `fleet` setting** on a pool (null = a plain tag pool, byte for byte as today). Values are closed sets or short patterns, because they are written into HCL.

| Key | Default | Why |
|---|---|---|
| `provider` | none (required) | `aws` or `gcp` |
| `region`, `zone` (gcp only, one) | none | multi-zone groups are not supported on Google Cloud |
| `profile` | `medium` | `small`, `medium`, `large`, `arm64`, `dind`: a table to machine types per cloud, reviewed in ELR-2 |
| `max_instances` | 10 (1 to 100) | the cost ceiling |
| `idle_count` | 0 | scale to zero; up to 10 warm instances |
| `max_use_count` | 1 | a fresh instance per job; the isolation ADR-0015 said an org had to build |
| `scope` | `group` | `group` or `project` runner; never instance-wide |
| `cache` | on | an S3 or GCS bucket with expiry, so a cache survives instances that do not |
| `warm` | none | hours with more idle instances; kept only if ELR-4 verifies the policy `periods` key |

**Fail closed.** `dind` with `max_use_count` above 1 is refused (privileged jobs would share a machine). A fleet with `max_instances` above 100, a region or zone off its pattern, or an unknown key is refused. The same schema is used by the API, the renderer and the table, so a stored fleet is always one the renderer accepts.

**What the stack creates**
- AWS: VPC and subnet (or ids you pass), an Auto Scaling group at 0 with scaling policy `none`, scale-in protection and `AZRebalance` off, a launch template (an AMI with Docker), an instance profile with no permissions, the manager (EC2, not spot) with an instance profile that may only call the group's resize and terminate actions, an S3 cache bucket with expiry, a Secrets Manager secret for the runner token.
- GCP: a managed instance group at target size 0 in one zone, an instance template, a service account with no roles for instances, the manager VM, a GCS cache bucket with expiry, a Secret Manager secret.
- The runner itself is created by Terraform (`gitlab_user_runner`, to verify in ELR-4) with the pool's tags and `run_untagged = false`. **The platform never sees the token.** The apply job needs a GitLab token with the `create_runner` scope, as a CI variable of the infrastructure project: a strong token, which the doc says to scope to one group.
- The stack carries `stack.yml`, so plan, policy, cost gates and drift treat it as any other stack. Feature 16's estimate then shows the fleet's idle cost (manager, cache bucket). Usage cost cannot be estimated and the page says so.

**How it reaches a repository.** `POST …/pools/:poolId/fleet/propose` renders the files and opens a **merge request** on the infrastructure project the admin names (invariant 6). Nothing is pushed to a default branch. The same branch name is reused, so proposing twice updates one MR.

**Health.** GitLab sees one runner per fleet: the manager. Instances are not runners (the executor needs no GitLab Runner on the image). So POOL-4 stays as it is: `healthy` means the manager is online. A fleet pool that is `offline` is worded "the fleet is not applied yet, or its manager is down". Capacity and stuck provisioning are not visible without the cloud or the runner's metrics (backlog).

**Light pipelines.** I read `packages/iac/src/pipeline-gen.ts`: every job already has `needs` and plan/estimate are `interruptible`, but **no job sets `GIT_DEPTH`, `GIT_STRATEGY`, `cache:` or any `FF_` flag**. On a fleet where each job boots a fresh instance, cost is jobs times boot plus image pull. A run of three stacks is at least 1 (`orch-generate`) + 3 plans + 3 summaries = **7 cold instances**, and three or more distinct images (the tool, the helper, the policy or cost image). The work, in order: **measure and pin** those numbers in a test (ELR-9); then `GIT_DEPTH: 1` on tool jobs and `GIT_STRATEGY: none` on the helper jobs that read only artifacts (ELR-10); a provider cache keyed on `.terraform.lock.hcl`, only for fleet pools, backed by the fleet's cache bucket (ELR-11); and the list of images a pool's stacks use, so the fleet can pre-pull or mirror them (ELR-12). Whether to go further (one summary per run instead of per stack, helper jobs on a small warm pool) waits for ELR-9's numbers: question 4. A pool with no `fleet` generates what it does today, byte for byte.

**GitHub fleets (cut E).** Same pool, same `fleet` setting, same schema; the **forge is the one of the infrastructure project's connection**, so no new key. What differs:

| | GitLab | GitHub |
|---|---|---|
| Scaler | GitLab Runner Autoscaler + fleeting, on a manager VM | GARM on a manager VM |
| What starts a job's machine | the manager sees queued jobs (it polls GitLab, outbound only) | **GitHub sends a `workflow_job` webhook to GARM**, so the manager needs an inbound HTTPS endpoint (to verify in ELR-4 whether GARM can avoid that) |
| Credential the manager holds | the runner token, in the cloud secret store | a GitHub App or token with rights to register runners, in the cloud secret store |
| How a job picks the pool | pool tags on the job | the pool's labels in `runs-on`, taken from the run's plan data (ELR-18) |
| Health | GitLab runners API | `GET …/actions/runners` through the forge seam; flag `runners` becomes true for GitHub (ELR-19) |

The platform holds neither credential on either forge. The credentials are created and stored by the fleet stack in the org's cloud. A GitHub pool that names an unknown or disabled pool **fails closed** as on GitLab. A GitHub run with no pool is byte for byte what it is today (`runs-on` as the file has it). The lighter-pipeline cuts (C) are GitLab only: GitHub has no generated pipeline, only a fixed workflow; ELR-9 counts its jobs too and the numbers decide whether it gets any tuning.

## Acceptance
- `orch pool add prod --fleet aws:eu-west-2 --profile medium --max 10` stores a pool with a fleet; a bad fleet is 422 with the key named; a plain pool is unchanged.
- The proposal opens one MR (GitLab) or one PR (GitHub) with `stack.yml`, the module call and a README; the HCL contains only values that passed the schema (an injection test with quotes, newlines, `${` and `%{` in every field).
- A stack on a fleet pool gets the pool's tags and the lighter settings; a stack on a plain pool or none is byte for byte unchanged (the existing structural test stays green).
- The weight test pins jobs, distinct images and hops for a representative run, so a job added later is a visible change.
- `terraform validate` on the rendered stack passes in an opt-in test (as actionlint is for GitHub workflows).
- A GitHub run whose stacks name a fleet pool gets `runs-on` from the plan data; an unknown or disabled pool refuses the run; a GitHub run with no pool is unchanged (the existing workflow test stays green).
- Not claimed: that a real instance boots, scales to zero or runs a job, on either forge. That is ELR-17 (GitLab) and ELR-23 (GitHub), human gates.

## Risks / human gates
- **ELR-1 (ADR-0022)** amends ADR-0015's non-goal "provisioning or autoscaling runners", rules out option (b), and **amends ADR-0019 item 8 so worker pools are allowed on GitHub**. D1 and invariant 3 are unchanged. Human gate.
- **GARM needs a reachable webhook endpoint** on the manager, so the fleet opens an inbound port that the GitLab design does not. It must verify GitHub's webhook signature; `/security-review` on ELR-20 and ELR-21. If ELR-4 shows no way around it, the fleet says so in its README.
- **GitHub self-hosted runners and untrusted code.** A fork's pull request must never run on a fleet runner: the workflow file keeps the repository's own rule and a test fails if a fleet `runs-on` is reachable from `pull_request` of a fork (ELR-18).
- **First real apply and first real job** on a sandbox AWS and GCP account (ELR-17). Human gate; nothing in the tests touches a cloud.
- **HCL is generated from settings.** The charset rules and the injection test are the defence. `/security-review` on ELR-8.
- **A strong token.** `create_runner` lets the apply job make runners. Scope it to one group and say so.
- **Cold start is real.** Fresh instance per job adds tens of seconds per job (not measured here). That is why the cuts exist, and why ELR-17 measures it.
- **One manager is a single point of failure** (the docs recommend two). Question 5.
- **GRIT is experimental** and autoscaler details change: the doc facts above are dated 2026-10-23.
- **Cost.** `max_instances` caps it per fleet; an org-wide cap and budget alarms are not built.

## Open questions (recommended answer first)
1. **Module source.** Our two small modules (about 150 lines of HCL each, pinned), borrowing GRIT's shape, or call GRIT? *Recommend ours:* GRIT is experimental and a platform that renders values must know the inputs it will meet. ELR-4 may change this.
2. **Runner scope.** Group runner by default, project as a choice, never instance-wide? *Recommend yes.*
3. **Spot job instances.** Left out in v1 for the reason above? *Recommend yes.*
4. **After ELR-9's numbers:** one `summary` job per run (cuts N boots to 1, but moves job names that the run events and the job nodes read), and helper jobs on a small warm second pool? *Recommend decide after measuring;* a yes adds ELR-24 and ELR-25.
5. **Manager count.** One, documented as a single point of failure, or two fleets with the same tags from day one? *Recommend one;* `managers: 2` later.
6. **Where it lives in the UI.** On the pool row in Settings (no new nav), or a Fleets page? *Recommend the pool row.*
7. **GitHub fleet engine.** GARM, VM based, no cluster (recommended), or ARC, which is the GitHub-supported controller but needs a Kubernetes cluster that the org would run and pay for? *Recommend GARM;* ARC is backlog.
8. **Lifting the GitHub pool refusal.** Allow pools on GitHub through ELR-1 (recommended; every other ADR-0019 refusal stays), or keep GitLab-only fleets until FRG-27 (a real GitHub) has been run?
