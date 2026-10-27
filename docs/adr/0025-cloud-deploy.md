# ADR-0025: Cloud deploys are shipped scripts run by the forge's runner, and deployments are recorded on GitHub too
Status: **Proposed** (the recommended answers to the SPEC's six open questions, taken on your "Go" of 2026-10-27 to finish features 33 to 37. Feature 36's tasks are built on it, so a reversal costs rework; **accept, amend or reverse it here**. Not accepted by anyone yet) · Roadmap: CLD-1, adds D20 · Builds on: ADR-0001 (D1), ADR-0019 (forge seam), ADR-0020 (deployments), ADR-0024 (blueprints) · **Amends:** ADR-0020's non-goal "Helm, SSH or compose templates shipped by the platform", and **ADR-0019 item 8 for deployments on GitHub** (every other refusal in item 8 stays)

## Context
Feature 31 records what is deployed where and can start a promote or a rollback, but the platform ships nothing that deploys: the repository's own `deploy.sh` runs in GitLab CI through the `docker-deploy` template, and GitHub is refused. Feature 35 now creates a Cloud Run or ECS Fargate service for a project. Nothing yet gets an app onto it. Coolify and Dokploy deploy by running a daemon on your server. Invariant 3 and D1 say the control plane holds no cloud credential; the forge's runner does, through OIDC.

## Decision
1. **One shipped script per cloud** (`deploy-cloud-run.sh`, `deploy-ecs.sh`), run by the forge's runner. Inputs are environment variables from a closed list, never free text on a command line. The script signs in with the runner's OIDC token (no key file), builds the image from the project's Dockerfile on the runner, pushes it to the service's own repository (Artifact Registry or ECR) tagged with the commit SHA, updates the service, waits until it is ready, and prints the URL. It never echoes a variable.
2. **Two thin wrappers around the same script:** a GitLab template (`cloud-run`, `ecs`, beside `docker-deploy`) and a GitHub workflow file delivered by the onboarding pull request. Only the way the OIDC token reaches the script differs.
3. **The deploy identity is a blueprint** (`deploy-identity`, GCP and AWS) in the catalog of ADR-0024: a workload identity pool and provider (GCP) or an IAM OIDC provider and role (AWS) that trusts the forge's issuer by an **exact `sub`**, allowed to update **one service** and push to **one repository**. A wildcard `sub`, a `*` action or resource and an owner or editor role are refused by a test. One identity per service.
4. **The first apply of a deploy identity is a one-time human bootstrap.** It creates the trust the pipeline later uses, so it cannot be applied by the pipeline it enables. It is documented and is a human gate (CLD-15).
5. **Deployments are recorded on GitHub.** `deployments.list/get` on the GitHub adapter (as designed in `docs/forge-seam.md`) and the `deployment_status` webhook, so the `deployments` capability flag becomes true for GitHub. The workflow names its environment with the platform's environment slug (the D14 rule, on GitHub too). Promote and rollback on GitHub start a `workflow_dispatch` of the deploy workflow with the same three inputs GitLab uses, correlated by run name. Approvals on GitHub are observed, not made (ADR-0019): a protected environment's required reviewers are GitHub's.
6. **Docker build on the runner and the cloud's own registry** (questions 1 and 2): no cross-registry pull rights, no cloud build service and second bill.
7. **Rollback redeploys a previous image tag from the deployment records.** The records keep the tag, not the image; a tag the registry has pruned fails with a sentence.
8. **D1 and invariant 3 do not change.** The credential is the runner's short-lived OIDC identity; the platform sets only non-secret variables (cloud, region, project or account, service, repository, identity, environment slug).

## Why this, and what was left out
- **(b) The platform calls Cloud Run or ECS** was rejected: it breaks invariant 3 and gives up the environment's protection, approval and audit.
- **(c) Install Coolify or Dokploy as the deployer** was rejected: they hold server access.
- **The cloud's build service** was rejected for this cut: more IAM, a second bill, and a build outside the runner's pool.
- **The forge's registry with a pull-through** was rejected: cross-account pull rights are exactly the sort of trust this keeps small.
- **One identity per environment** was rejected: a larger blast radius than one per service.
- **Waiting for a real GitHub run (FRG-27) before lifting the flag** was rejected: the lift is limited to deployments and every other ADR-0019 refusal stays, each pinned by a test.
- **Previews** (Cloud Run revision tags, a per-PR service on ECS) are held as CLD-16.
- **Helm, SSH and Compose** stay out: the repository's own `deploy.sh` remains the way to do those.

## Consequences
- **Shipping scripts is a new kind of platform output.** They are small, tested with stub CLIs, and read only the closed variable list; a change to one is reviewed like code.
- **This edits an accepted ADR for one item.** ADR-0019 item 8 now reads "deployments are recorded on GitHub (ADR-0025); the rest of the refusals stand". Feature 31 and ADR-0020 are themselves Proposed: if they change, this changes.
- **The trust is the danger.** If the `sub` condition is wrong, another repository could assume the role. It is written per forge from the project path and the ref or environment, tested per forge, and `/security-review` runs on both modules.
- **Nothing here has deployed to a real Cloud Run or ECS.** The scripts have met stub CLIs only. The first real deploy (CLD-15) is a human gate.
- **A runner needs Docker.** Feature 33's profiles say how a pool gets it; the two features are linked, not merged.
- **A rollback to a pruned image fails.** Both registries keep images by default; CLD-2 checks the retention each cloud applies.
