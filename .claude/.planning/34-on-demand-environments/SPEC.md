# 34 On-demand environments - Spec
Prefix: ODE · Milestone: M5 · Status: planned 2026-10-23, waiting for your go (no product code written, **no design made yet**, see Design) · Needs: 04, 09, 11, 16, 25, 31, 35 · Came from: "I want to be able to spin up and down full infrastructures … like how Heroku does in AWS … create an environment in a cloud like AWS, GCP with resources … spin up a full environment with selected resources" (2026-10-23; example `Carebell/Platform/infrastructure`; links Qovery, Porter, Northflank, Encore, Walrus); then "I want the ability for this to work with GitHub or GitLab" and "a powerful tool like Coolify, Dokploy … to easily manage resources and deploy new ones" (2026-10-23), which add the Forge section, ODE-20 and ODE-21

**Reading note:** wherever this plan says *merge request* or *MR*, a GitHub project gets a **pull request** through the same forge seam. Differences are in the Forge section.

## Goal
Pick the resources an environment needs, see what it will cost, create it in the organization's **own AWS or GCP account**, and tear it down again: by hand, on a timer, or (later) when a merge request closes. The platform still holds no cloud credential.

**Is it possible? Yes, with one deliberate limit.** Qovery, Porter, Northflank and Encore Cloud do it by holding a role in your cloud account and calling it, or by running their own engine there. This platform is built the other way (D1, invariant 3): the CI runner holds the cloud credentials. So **creating an environment is a merge request plus a pipeline, not a call to AWS**. What you get for that: the environment is Terraform you can read, review and keep, and the platform holds nothing it could lose. What it costs: the first environment waits for a review. The fast, no-merge-request path is for later previews (backlog).

Most of the machine exists: stacks and their dependency waves (09), plan and apply with approvals (09, 11), cost gates (16), policy, platform environments with variables (04), deployments and the environment-name rule (31). **Missing: a way to pick resources, a destroy, and a timer.** No AWS or GCP code is written: the stacks are Terraform, so any provider your modules use works. The list of resources you can pick is only as good as your modules. **Where a repository has none, feature 35's blueprints are the modules** (ODE-20 creates an environment from them); this feature adds no catalog of its own.

## What I read (2026-10-23)
| Source | Read | Taken |
|---|---|---|
| [Qovery](https://www.qovery.com/) (home page) | "your data and compute stay inside your own AWS, GCP, or Azure account"; a preview environment "one per pull request, torn down automatically when it's no longer needed"; blueprints; bring your own cluster. The page says nothing on clone or auto-stop | The preview shape (backlog); the BYOC promise, met a different way |
| [Encore](https://github.com/encoredev/encore) (README) | Infrastructure is derived from application code; the platform "connects to your AWS or GCP account and provisions the resources your code declares in your own VPC"; a pull request gets an ephemeral environment; least-privilege IAM; MPL-2.0; the managed platform is commercial. Teardown is not described | Not taken: infrastructure from application code. Previews, later |
| [Walrus](https://github.com/seal-io/walrus) (README) | Resource definitions that ops write and developers request; orchestrates services and their resources over OpenTofu/Terraform; "Dynamic Environment Management" starts and stops environments. **Archived by its owner on 16 Sep 2024, read-only** | The "ops define, others pick" idea. Not a base to build on |
| Porter, Northflank | **Not read.** Prior knowledge only: Kubernetes in your cloud, preview environments, templates | Nothing copied until read |
| The Carebell example (folder and file names only, no file contents beyond one `backend` line) | `stacks/layer-{0-foundation,1-platform,2-workloads}/{_shared,dev,staging}/<stack>`; stacks such as network, kms, database, gke, redis, cloud-run, edge, dagster, livekit, website; modules `cloud-run-service`, `edge-lb`, `website`. **No `stack.yml` anywhere**, no Terragrunt. Each directory is plain Terraform with a `backend "gcs"` block whose `prefix` is fixed (`layer-2/edge`) and no bucket in the file | The shape to design against (below) |

## Scope
A) A decision (ADR-0023). B) Describe a stack for the picker and record an environment's life. C) **Create**: choose from a template environment, propose the clone as a merge request. D) **Destroy** as a run. E) **Timer** for ephemeral environments. F) CLI, web, docs.

## Non-goals
- Previews per merge request (create on open, destroy on close) and "instances of one parametric stack" with no merge request. Backlog; they need A to D proven first.
- A module catalog of its own (feature 35 is the catalog), Kubernetes clusters the platform runs, and deploying applications (features 31 and 36 do that).
- Stop and start of an environment that keeps its data (Walrus's idea). A destroy removes things.
- Terragrunt destroy, DNS zone destroy (DNSControl has its own delete rule), cross-account or cross-organization environments.
- Copying secret values. Ever.

## Design
**An environment is a platform environment.** The `environments` table (04) already has a slug and is what `stack.yml` `environment:` names and what feature 31's deployments use (D14: GitLab's environment name equals the slug). An infrastructure environment is that same row plus `ephemeral` and `expires_at`. Its stacks are the stacks whose `stack.yml` says `environment: <slug>`. Its state (creating, live, destroying, destroyed) is **derived from those stacks' states**, not stored, so it cannot disagree with them. One new stack state, `destroyed`.

**The picker's list is the template environment's stacks.** New optional `stack.yml` keys describe a stack to a person: `title`, `kind` (database, network, service, edge, …) and `optional` (false = always included). A stack's `depends_on` already orders it, so picking `cloud-run` pulls in what it needs (the selection closure), shown as locked.

**Create = clone, by merge request.** `POST …/environments` `{name, template, picks, ephemeral?, ttl?, connectionId}` makes the environment row (state `creating`) and opens one MR (invariant 6) that adds, for each chosen stack, a copy of its directory with the template's slug segment replaced by the new name, its `stack.yml` renamed (`name` and `environment:`), and nothing else touched. From there the existing flow runs unchanged: the MR is planned in wave order, the cost estimate and policy show on it, approval and apply work as today.

**Fail closed on shared state.** Copying a stack whose state lives somewhere that does not change with the copy would make the new environment manage the template's real resources. The Carebell stacks are exactly this (`gcs`, fixed `prefix`). So the clone **refuses a stack whose backend is not `http`**, or an `http` one the platform names by stack (GitLab-managed state is named after the stack, so a renamed stack has its own empty state; whether the platform's own `state: orch` is keyed the same way is checked in ODE-2, and the clone refuses until it is known). The message names the stack and says why. For Carebell that means a one-time, human move of those stacks to `backend "http" {}` with `terraform init -migrate-state` before they can be cloned. Resource names that are hardcoded in the module collide at apply ("already exists"); the plan on the MR is where that shows. It cannot be known earlier.

**Variables.** The new environment starts with **no values**. The page and CLI list the template's variable **names** so you fill them. A variable that is not a secret may be copied on request; a secret's value is never copied by this route (question 2).

**Destroy = a run kind.** `POST …/environments/:slug/destroy` `{confirm: "<slug>"}`. For each of the environment's stacks, in **reverse wave order**: `plan -destroy` saved as a plan, its summary posted, then the apply of that saved plan, with the same rules as an apply (the plan being the one judged, the apply gate, the policy and cost checks). Required: the stack says **`destroy: allow`** (new `stack.yml` key, default `refuse`, like `dns.prune`: delete is an opt-in made in code review), the caller is a maintainer, the typed name matches, and for a **protected** environment an approved change request (11). `plan -destroy` is the dry run (invariant 5). The summary already carries each resource's type and action (never values), so the confirm step can say "this removes 2 databases and 1 bucket" from an allowlist of data-bearing types, and a Terraform `deletion_protection` or non-empty bucket error surfaces as the stack's `failed`, not a bypass. After a destroy the stack is `destroyed`, drift checks skip it, and the platform offers a second MR that removes the directories.

**Timer.** An environment created `ephemeral: true` gets `expires_at` (`ttl`, such as `8h` or `3d`). The worker destroys an **expired, ephemeral** environment as the actor `system`, once (a unique run guard), after a `environment.expiring` notification an hour before, and `PATCH` extends it. A non-ephemeral environment is never touched by the timer, and ephemeral cannot be switched on for a live environment without a change request. An organization cap on live ephemeral environments (default 5) bounds the spend.

**Create from blueprints (ODE-20).** For a repository with no template environment, `POST …/environments` may take `blueprints: [{kind, cloud, name, uses…}]` instead of `template` and `picks`. It reuses feature 35's `renderBlueprint` for each entry, adds the environment row, and opens **one** change with all the stacks, wired by `uses`. The picker's list is then the blueprint catalog (network, service, postgres, bucket on AWS or GCP) with locked requirements from `uses`. Destroy, timer and status work the same, because the result is ordinary stacks with `destroy: allow` set by the blueprint (the blueprint's own deletion-protection settings still make a database refuse until a person lifts them in code).

**Forge.** The same routes work on a GitLab and a GitHub project; what differs:
- *Create* opens an MR or a PR through the forge seam; the clone is planned by the existing flow on either forge (ODE-8 is tested on both mocks).
- *State*: a GitHub stack's state is the platform's (`state: orch`) because GitLab-managed state is refused there. The shared-state guard is therefore "the backend is `http`" on both forges; the key that selects who serves it is not copied blindly (ODE-6).
- *Destroy* on GitHub rides the static stack workflow: the plan data carries `action: destroy` and stacks in reverse wave order, and the workflow runs a matrix per level (ODE-21). **A GitHub project onboarded before this feature has the old workflow file, so it must merge a workflow-update pull request first**; the destroy route refuses with that sentence until the delivered file is current.
- *Approvals* on GitHub are observed, not made (ADR-0019): a protected environment's change request is the platform's, the required reviewers are GitHub's.
- *Cost estimate* is refused on GitHub (flag); the picker says "no estimate on GitHub".

**Cost.** The MR's plan note already shows the estimate for the clone (16, GitLab only). The picker shows each stack's last known monthly figure from the template's runs, or "unknown". No figure for usage-based items.

**Invariants.** 1: no secret copied, no value in a summary, log or audit row (leak test on destroy and clone). 2: all GitLab traffic through `packages/gitlab`. 3: no credential; destroy runs on the runner by OIDC. 4: every route a guard, every mutation an audit event, including the timer's. 5: plan then apply, dry run, delete opt-in. 6: create is an MR. 7: mock only. 8: additive migration.

## Design (screens)
**Not made yet. It is made once, together with the resources screen of feature 37** (RSH-2), because the picker and the Destroy dialog live on that screen. The one new surface is the picker (resources, locked requirements, name, ttl, cost note) and the environment status with its Destroy dialog. The nearest sibling is the pipeline wizard in `onboarding.tsx`, which is choose, preview, open an MR, but a resource picker is not that. I did not draw it before you answer questions 2, 4 and 7, which change what is on the screen. On your go, the design is made in Claude Design before ODE-16 with the repo rules (Carebell tokens, `components.tsx` parts, 44 px targets, status as glyph plus word), and you approve it before it is built, as with feature 32. Say "design it now" to do it first.

## Acceptance
- With the mock GitLab **and the mock GitHub**: create `pr-1` from `dev` with picks → one MR (or PR) holding only the chosen stacks and what they need, renamed; a stack with a non-`http` backend is refused by name; nothing reaches a default branch.
- Create from blueprints (ODE-20) on both mocks: one change with every chosen stack, wired and ordered by `uses`.
- GitHub destroy: refused with the workflow-update sentence when the delivered file is old; with a current file, the plan data and the workflow run the reverse waves (a workflow test and a mock run).
- The MR is planned by the existing flow in wave order (an integration test, no flow change).
- Destroy: refused without `destroy: allow`, without the typed name, without the role, and (protected) without an approved change request; the generated pipeline runs reverse waves from saved plans; the confirm step lists data-bearing types; audit events exist; a leak test finds no value anywhere.
- Timer: an expired ephemeral environment is destroyed once; a non-ephemeral one never; the cap holds; `system` is the audited actor.
- Not claimed: that anything was created or destroyed in a real cloud, on either forge. That is ODE-19, a human gate.

## Risks / human gates
- **ODE-1 (ADR-0023)**: a destroy run kind and a timer that acts with no person asked. The highest-risk action this platform would own. Human gate; `/security-review` on ODE-7, ODE-10 and ODE-13.
- **Irreversible loss.** A destroy removes data. Mitigated by `destroy: allow`, the typed name, the data-bearing warning, change requests for protected environments, and `ephemeral` for the timer. Not mitigated: a KMS key scheduled for deletion cannot be brought back by us.
- **Shared state** (above) is the clone's worst failure. The guard is a test, not a hope.
- **Copy-per-environment repositories** collide on names. The plan shows it; a parametric module is the real fix and is the user's code.
- **Spend.** Ephemeral environments cost money until destroyed. The timer, the cap and the estimate bound it; a budget alarm is not built.
- **Partial create.** A cloud quota can stop an apply half way. The environment shows `failed` per stack; retry or destroy through the same runs.
- **Feature 31 and ADR-0020, and feature 11, are Proposed or human-gated**: the environment-name rule and change requests are relied on.
- **Phase of the example.** The Carebell repository is not onboarded (no `stack.yml`). Adding the files is the first step for a user there (ODE-2 writes down exactly what).

## Open questions (recommended answer first)
1. **Clone first, or instance mode first?** Clone: it works on a copy-per-environment repository like Carebell's today, and blueprints (ODE-20, feature 35) cover a repository with none. Instance mode (one parametric stack, state per instance, started by a pipeline with variables, no merge request) is what previews need and your modules are not written for it. *Recommend clone and blueprints now, instances with previews later.*
2. **Variables of the new environment.** Empty plus the template's key names (and non-secret values on request), or nothing listed? *Recommend that.* Secret values are never copied.
3. **Shared-state guard.** Refuse any non-`http` backend (recommended), or allow a stack to declare which backend key to rewrite? *Recommend refuse; the second is more code and more ways to get it wrong.*
4. **Who may destroy.** Maintainer plus the typed name; protected environments need an approved change request; the timer only for `ephemeral` environments. *Recommend as written.*
5. **Where "what can be picked" lives.** `title`, `kind`, `optional` in the template's `stack.yml` files (recommended: no second catalog to drift), or one catalog file per repository?
6. **Cap on live ephemeral environments.** Default 5 per organization, changeable by an admin. *Recommend yes.*
7. **Previews per merge request.** Plan them now as a cut G, or after this is real? *Recommend after:* they reuse create and destroy and add webhook rules.
8. **GitHub destroy needs a newer workflow file.** Require a workflow-update PR before the first destroy on a GitHub project (recommended: the file is static and reviewed), or have the platform refuse destroy on GitHub in the first cut?
