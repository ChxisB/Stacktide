# 09 IaC Stacks and Runs - Spec
Prefix: IAC · Milestone: M3 · Status: todo

## Goal
Terraform/OpenTofu orchestration on top of GitLab CI: discover stacks, plan on every MR for the stacks that changed, apply the saved plan on merge or by command - with the platform never touching cloud credentials.

## Scope
Stack model + discovery; dependency DAG; change detection; child-pipeline generation; run lifecycle and ingest; MR comments and commands; apply flow; state backend wiring; stack variables.

## Non-goals
Policy and drift (10), approvals on protected environments (GOV-3), running Terraform in the control plane, graph/SQL state (backlog), storing job logs (we link to the GitLab job).

## Design
- **Stack** = a directory with a marker `stack.yml`: `name`, `tool` (terraform|tofu|terragrunt), `version`, `tags`, `depends_on`, `watch` (extra paths such as shared modules), `apply_on` (merge|command). Explicit marker in v1 (Terramate/Atlantis style); auto-detect is later.
- **DAG**: `depends_on` -> waves for parallel execution; cycle detection; `affected = changed + transitive dependents`.
- **Change detection**: GitLab compare API on the MR -> changed paths -> stacks whose dir or `watch` paths match.
- **Execution**: the platform generates a dynamic child-pipeline YAML (artifact) with a job per stack, `needs` between waves and `resource_group: stack-<name>` (GitLab's mutex) per stack. Jobs authenticate to the platform and to the cloud with `id_tokens`/OIDC. The `plan` job saves the plan file as an artifact and posts a JSON summary.
- **Apply** applies only the saved plan, and only if: the plan was made from the current head SHA, the MR is approved and mergeable, no other run is active on the stack, and the actor is authorised (merge on default branch, or an MR note command).
- **Commands** are MR notes `orch plan [stack]` / `orch apply [stack]` (no leading `/`, which GitLab treats as a quick action).
- **State** (D9): GitLab-managed Terraform state through the HTTP backend env (`TF_HTTP_ADDRESS`, lock/unlock addresses, `gitlab-ci-token` + `$CI_JOB_TOKEN`); stack code declares `backend "http" {}`. A custom backend can be passed through.
- **Run states**: queued -> planning -> planned -> applying -> applied | failed | discarded | canceled. Transition table is pure and tested.

## Acceptance
On a fixture repo with three dependent stacks, opening an MR that edits one stack plans that stack and its dependents in the right order, posts one updating MR comment, and `orch apply` (or merge) applies exactly the saved plans.

## Risks / human gates
Anything that applies to real infrastructure. The first real plan/apply is a human gate; run it against a throwaway stack. `/security-review` on IAC-6, IAC-8, IAC-9.
