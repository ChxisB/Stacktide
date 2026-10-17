---
name: software-factory
description: Plan and build the DevOps Orchastrature platform (Bun + TypeScript control plane for GitLab CI/CD pipelines, variables/secrets sync and IaC stacks) through a gated pipeline - spec, mini-task breakdown under .claude/.planning/{feature}/, test-first build, verify and review, hand-off. Use for "factory <feature>", "/software-factory", "plan feature X", "build/continue X", "what's next", or whenever a feature must be broken into tasks.
---

# Software Factory - DevOps Orchastrature

You orchestrate the build of this platform: a Bun + TypeScript **control plane** that sets up GitLab CI/CD for projects, manages variables/secrets and syncs them to targets, and orchestrates IaC stacks. GitLab CI is the runner; the platform never holds cloud credentials. Work one small task at a time through the gates below.

## Orient first (every invocation)
1. Read `.claude/.planning/ROADMAP.md` (decisions D1-D12, feature order, status).
2. Read the feature's `SPEC.md` and `TASKS.md`, plus its rows in `.claude/.planning/REFERENCES.md`. Fetch an upstream repo only when the row is not enough.
3. Read the code the task touches. Match its naming, layering and test style.

## Commands
| Input | Does |
|---|---|
| `plan <feature>` | Phase 1 only. Create or refine `SPEC.md` + `TASKS.md`, add the feature to ROADMAP, **stop for approval**. |
| `next` | Pick the first `[ ]` task whose deps are all `[x]` (ROADMAP order), run Phases 2-3 on it, stop. |
| `run <TASK-ID or feature>` | Same loop for the named task, or every open task of the feature in order. |
| `status` | Print per-feature progress from the TASKS files. Changes nothing. |
| free text | Matches an existing feature -> `run`. Otherwise -> `plan` a new feature. |

## Layout (one directory per feature)
```
.claude/.planning/
  ROADMAP.md  REFERENCES.md
  NN-feature-slug/
    SPEC.md    goal, scope, design, acceptance, risks
    TASKS.md   the mini tasks - the unit of work
    LOG.md     appended after each task (create on first task)
```
New feature = next free `NN-`, a unique 2-5 letter task prefix, one ROADMAP row.

## Phase 1 - Research & Spec (read-only until approved)
- Explore the code and the matching REFERENCES rows. Do not write product code.
- Write `SPEC.md`: goal, scope, non-goals, design, feature-level acceptance, risks, open questions.
- Write `TASKS.md`. **Every task must be small**:
  - S (under ~1h) or M (1-3h). Anything bigger is split. No L.
  - One observable outcome, one commit's worth of change.
  - Explicit `deps` (task IDs), explicit "Done when" naming the test that proves it.
  - Ordered so each task leaves `bun run check` green.
- Task format:
  ```
  ### PFX-3 - Title  `[ ]` S - deps: PFX-1
  Do: what to build, in 1-3 lines.
  Done when: the test or command that proves it.
  ```
- Statuses: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked.
- **Gate:** show the user the task list and wait for a go.

## Phase 2 - Build (loop per mini task)
1. Confirm deps are `[x]`. Mark the task `[~]`.
2. Write the failing test first, then the smallest code that passes it. Tests and code land together.
3. Prefer, in order: existing code, Bun/stdlib, an installed dependency. A new dependency needs a one-line justification in `LOG.md`.
4. Do not widen scope. If the task is wrong or too big, edit `TASKS.md` (split/add), say so, and continue.

## Phase 3 - Verify & Review (per task)
- Run the gate: `bun run check` (= typecheck + lint + test). Until FND-3 exists, use `bunx tsc --noEmit` + `bun test`.
- Never weaken, skip or delete a test to get green. Same failure 3 times -> mark `[!]`, write the blocker in `LOG.md`, ask the user.
- Review the diff against the invariants below, then run `/code-review`. Also run `/security-review` when the task touches auth, crypto, secrets, webhooks, token handling or sync adapters.
- Mark `[x]`, append to `LOG.md`: date, task ID, what changed, gate result, new dependencies, follow-ups.
- Stop after each task unless the user asked for a batch.

## Phase 4 - Delivery (when a feature's tasks are all `[x]`)
- Summarise: changes, test results, remaining risks, open follow-ups. State failures and skipped steps plainly.
- Write `.claude/completions/YYYY-MM-DD-{feature}.md` (same summary). Set the feature to `done` in ROADMAP. Move any session file to `.claude/sessions/archive/`.
- Commit, push or open an MR only when the user asks.

## Invariants (check every diff against these)
1. **No plaintext secrets** in logs, errors, audit payloads, run summaries, list responses, snapshots or fixtures. Any task handling values adds a leak test.
2. All GitLab traffic goes through `packages/gitlab`; all target I/O through a `SyncAdapter`. No stray `fetch` to those systems.
3. The control plane holds **no cloud/IaC credentials**; the CI runner does (OIDC). Exceptions need an ADR (see EXT).
4. Authz is deny-by-default: every route declares a guard, every mutation writes an audit event.
5. Changes to external systems are plan -> apply, idempotent, dry-run capable. Delete/prune is explicit opt-in.
6. Nothing is pushed to a default branch. Repo changes land as MRs.
7. Tests never touch real GitLab or cloud. Use the mock (GL-5); real E2E is opt-in via env, sandbox group only.
8. Migrations are forward-only and additive alongside the code that needs them.

## Human gates - stop and ask before
- Confirming or changing a ROADMAP decision (D1-D12) or adding/removing tasks in an approved SPEC.
- Crypto, key handling, auth/RBAC model changes.
- Destructive or data-altering migrations; delete/prune semantics.
- Anything that writes to a real GitLab instance or cloud account.
- A heavy new dependency or external service.
- Commit, push, MR, publish.

## Protected files
Never read into output, edit or create: `.env*` (except `.env.example`), `*.key`, `*.pem`, `secrets.json`. Use `.env.example` for new settings.
