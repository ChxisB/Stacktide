# 36 Cloud deploy - Spec
Prefix: CLD · Milestone: M5 · Status: planned 2026-10-23, waiting for your go (no product code written) · Needs: 25, 31, 35 · Came from: "I want to be able to deploy to GCP or AWS", "work with GitHub or GitLab", "deploy new ones in an all in one platform" (2026-10-23)

## Goal
An app in a project gets onto the **service** a blueprint (feature 35) created on **GCP (Cloud Run) or AWS (ECS Fargate)**, from **GitLab or GitHub**: build the image, push it, update the service, record the deployment, and let a person **promote or roll back** from the CLI or the page. The platform still holds no cloud credential: the forge's runner holds a short-lived identity it gets by OIDC.

Today (feature 31) the platform deploys nothing itself: the repository's own `deploy.sh` runs in GitLab CI through the `docker-deploy` template, and GitHub is refused (ADR-0019 item 8, flag `deployments` is false). This feature adds **shipped deploy scripts for the two clouds** and lifts the GitHub refusal for deployments.

## What I read (2026-10-23)
| Source | Result | Taken / not taken |
|---|---|---|
| `docs/deployments.md`, feature 31 SPEC, ADR-0019, `docs/forge-seam.md` (this repository) | Deployments are records from the forge; promote and rollback are a platform-started pipeline with three `ORCH_DEPLOY_*` variables; GitLab environment name equals the platform environment slug (D14, Proposed); non-goal "Helm, SSH or compose templates shipped by the platform"; GitHub `deployments.list/get` is designed in the seam doc (`GET /deployments`, statuses, the `deployment_status` webhook) but the flag is false | The record and promote model is reused. The non-goal is amended by ADR-0025 |
| [Coolify](https://github.com/coollabsio/coolify) and [Dokploy](https://github.com/dokploy/dokploy) READMEs | Deploy by webhook or push, rollback to a retained image, health checks, logs, PR previews | The *behaviour* (deploy, rollback, health) is the target. Their method (a daemon on your server) is not |
| Cloud Run, ECS, Artifact Registry, ECR, Workload Identity Federation, IAM OIDC provider, GitHub OIDC claims | **Not read.** Prior knowledge: `gcloud run deploy --image`, `aws ecs register-task-definition` and `update-service`, GitHub and GitLab both issue OIDC tokens a cloud can trust by `sub` | CLD-2 verifies each before a script is written |

## Scope
A) A decision (ADR-0025) and a spike. B) A deploy identity per cloud (a blueprint). C) Two deploy scripts and their GitLab and GitHub wrappers. D) GitHub deployment records, promote and rollback. E) Wiring the service resource to the deploy, CLI, docs, a real deploy.

## Non-goals
- A daemon, agent or SSH on any server; Docker Swarm, Compose, Helm or Kubernetes deploys (the repository's own `deploy.sh` remains the way to do those, as in feature 31).
- Build packs and a build service. The team's Dockerfile is built on the runner (CLD-5 says how).
- Blue/green and canary traffic splitting. A deploy replaces the revision; rollback redeploys a previous image. (Cloud Run revision tags for previews are held as CLD-16.)
- Database migrations as a platform step: the team's job. A deploy script with a `pre` hook may be added later.
- Azure.

## Design
**One script per cloud, two thin wrappers.** `packages/pipelines/scripts/deploy-cloud-run.sh` and `deploy-ecs.sh` take their inputs as environment variables, never as free text on a command line, and do: sign in with the runner's OIDC token (no key file), build the image from the Dockerfile on the runner (as `docker-image` does) and push it to the service's repository, update the service to that image, wait until it is ready, print the URL. Wrappers: a GitLab template (`cloud-run`, `ecs`, next to `docker-deploy`) and a GitHub workflow file (delivered by the onboarding PR, as the stack workflow is). The script is the same on both forges; only the way the OIDC token reaches it differs.

**Inputs the platform sets** (non-secret, deterministic, from the service resource of feature 35): cloud, region, project or account id, service name, image repository, the deploy identity to assume, environment slug. They are written as CI variables or workflow inputs of the *non-secret* kind; the platform does not hold a secret to put there. The image tag is the commit SHA.

**The deploy identity is a blueprint** (`deploy-identity`, GCP and AWS, in the catalog of feature 35): GCP: a workload identity pool and provider trusting the forge's issuer, and a service account allowed to update **that one service** and push to **that one repository**; AWS: an IAM OIDC provider and a role with the same two permissions. The trust condition names the exact `sub` (project path and, for protected environments, the protected ref or environment); **a wildcard `sub` is refused by a test**. Creating the trust needs cloud rights the platform does not have, so its **first apply is a one-time human bootstrap** (documented, a human gate), like any stack that creates the trust the pipeline later uses.

**Records (GitHub).** `deployments.list/get` for GitHub is implemented as designed in `docs/forge-seam.md` (`GET /repos/{o}/{r}/deployments` plus statuses, and the `deployment_status` webhook), the `deployments` flag becomes true for GitHub, and feature 31's screens work on both forges. The workflow creates the deployment with the environment name equal to the platform environment slug (the D14 rule, on GitHub too).

**Promote and rollback.** GitLab: unchanged (platform-started pipeline, three `ORCH_DEPLOY_*` variables). GitHub: a `workflow_dispatch` of the deploy workflow with three inputs (the same three), correlated by run name as stack runs are. A rollback redeploys a **previous image tag from the deployment records** (the registry is not trusted to keep it, but both clouds' repositories keep it by default; verified in CLD-2). Approvals on GitHub are observed, not made (ADR-0019): a protected environment's required reviewers are GitHub's.

**Forge.** Everything goes through `packages/forge`; no `fetch` to GitHub from the deploy code. The cost estimate and the `runners`, `managedState` flags are not involved. What GitHub lacks (`dynamicPipeline`) is not needed: the deploy workflow is static.

**Invariants.** 1: no secret in a script, variable, log, record or audit row (leak test on the script's output and the workflow file). 2: forge traffic via the seam. 3: the platform holds no credential; the *runner's* OIDC identity does, scoped as above. 4: routes guarded and audited as feature 31's. 5: a deploy is not a plan/apply, but promote is gated by the environment's protection and change request; rollback is a deploy of a known image. 6: nothing is pushed to a default branch (the workflow file arrives by PR). 7: mock only. 8: no migration expected (CLD-12 may need one small additive column; it says so).

## Acceptance
- On the mock GitLab and the mock GitHub: the shipped wrapper, given a service resource, produces a pipeline or workflow whose script is the shipped one, with only the allowed variables, and no secret in the file (snapshot and leak test).
- The shipped scripts pass `shellcheck` if installed (named as skipped otherwise) and a test that runs them with a stub `gcloud`/`aws`/`docker` on `PATH`, asserting the exact commands and that no key file is written.
- The deploy-identity modules pass the policy test: no wildcard `sub`, no `*` action or resource, the role covers one service and one repository.
- GitHub deployment records list, get and update from the webhook on the mock; the `deployments` flag is true for GitHub and the screens of feature 31 show them.
- Promote and rollback start a `workflow_dispatch` with the three inputs on the mock GitHub, and a pipeline with three variables on the mock GitLab.
- Not claimed: that anything deployed to a real Cloud Run or ECS, or that a real OIDC trust works. That is CLD-15, a human gate.

## Risks / human gates
- **CLD-1 (ADR-0025)**: shipping deploy scripts is a new kind of platform output, and **lifting the GitHub refusal for deployments edits an accepted ADR (0019 item 8)**. Human gate.
- **Trust bootstrap.** The deploy identity cannot create itself. If the wildcard-`sub` test is wrong, any repository could assume the role. `/security-review` on CLD-3 and CLD-4.
- **Where the image lives.** Cloud Run and ECS pull from the cloud's own registry, which the service module of feature 35 must create (and BLP-6/7 do); a build that pushes to the forge's registry instead would need cross-account pull rights. Unverified (CLD-2).
- **Docker on the runner.** Building needs Docker (or a rootless builder) on the pool; feature 33 gives `dind` profiles with `max_use_count=1`, which is why they are linked, not merged.
- **GitHub OIDC claims** differ from GitLab's; the condition is written per forge and tested per forge.
- **A rollback to an image the registry has pruned** fails; the record keeps the tag, not the image.
- **Feature 31 and ADR-0020 are Proposed.** This feature builds on them; if they change, this changes.

## Open questions (recommended answer first)
1. **Image registry.** The cloud's own (Artifact Registry, ECR; recommended: no cross-registry pull rights) or the forge's registry with a pull-through?
2. **Build on the runner.** Docker build on the runner (recommended; matches `docker-image`) or the cloud's build service (needs more IAM and a second bill)?
3. **GitHub deployments flag.** Lift it for deployments only (recommended; every other ADR-0019 refusal stays) or wait for feature 25's real-GitHub task (FRG-27) first?
4. **Deploy identity scope.** One identity per service (recommended: smallest blast radius) or one per environment?
5. **Previews.** Cloud Run revision tags and per-PR services held as CLD-16 (recommended) or in now?
6. **Health.** The script waits for the service's own ready signal and fails the job if it does not come (recommended), no custom health URL in this cut.
