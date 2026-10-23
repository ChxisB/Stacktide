# 31 deployments - built 2026-10-21 (ADR-0020 and D14 still Proposed; nothing run against a real GitLab)

The platform now follows a project's deployments and can start them. GitLab reports deployments (the Deployment Hook and a Refresh), the platform stores them, shows what is deployed where, starts a promotion or a rollback as a pipeline on the default branch, holds a protected environment behind a four-eyes approval, tells people when a deployment fails and shows how often deployments succeed. Everything was built on your blanket go to finish every open task, using the SPEC's recommended answers. Nothing is committed.

## What was built
- **A, reading (DEP-1..8).** ADR-0020 (Proposed) and decision D14; `GitLab` reads deployments and environments (`packages/gitlab/src/deployments.ts`, mock helper `mock.addDeployment`); the `deployments` table (migration 0055); the Deployment Hook and its `gitlab.event` consumer (the hook gives a job three fields, the consumer asks GitLab and stores that); Refresh; the history and what-is-where reads (`deployment.read`); the Deployments card on the Status page; `orch deploy status`.
- **B, the template and the docs (DEP-9, 10).** `docker-deploy` 1.0.0 (a rollback pipeline needs no code change); `docs/deployments.md` and the hook.
- **C, promote and roll back (DEP-11..15).** The plan (`apps/api/src/promotion.ts`: validation, refusal codes, `rollbackTo`); promote and roll back as a platform-started pipeline with `ORCH_DEPLOY_ENV`, `ORCH_DEPLOY_SHA` and `ORCH_PREVIOUS_SHA`, a dry run first; the buttons and a dialog in the card; `orch deploy promote` and `rollback`.
- **D, protected environments (DEP-16..18).** A change-request kind `deploy` (migration 0056); promote and rollback consume the approval in the same transaction as the start; Ask, Approve and Reject in the card and the CLI.
- **E, telling and counting (DEP-19..21).** `deployment.failed` notification (migration 0057, with the pipeline's address told and not stored); `GET .../deployments/stats` and `deployment-stats.ts` in core (count, per week, failure rate, time to restore); the numbers in the card and `orch deploy status --stats`.
- **F, demo and delivery (DEP-22, 23).** The demo seed has a `docker-deploy` config and nine deployments; `bun run demo:shots` takes the card and the Promote dialog at 1280 and 390 in both themes; docs, README, ROADMAP row.
- **New routes:** 6 (three reads: the history, what is where, the numbers; three writes: Refresh, Promote, Roll back; Ask, Approve and Reject reuse the change-request routes); authz actions `deployment.read`, `deployment.refresh`, `deployment.promote`, `deployment.rollback`); pins at 178 routes and 174 operations; `docs/openapi.json` regenerated.
- **Migrations:** 0055, 0056, 0057, all additive.
- **No new dependency.**

## Existing tests that changed (each a finding in LOG.md; none weakened, skipped or deleted)
- **Route counts and lists (DEP-5, 6):** `authz.test.ts` route map and 401 count, `spec.test.ts` operations, `routes.test.ts` audit actions, `packages/core/src/authz.test.ts` action table; each moved for the routes added and nothing else.
- **DEP-17:** six tests that pinned `environment_protected` or the plan's exact keys now pin `approval_required` and one more key (`protected`, `environmentId`): `promotion.test.ts`, `deployments.test.ts`, CLI `deploy.test.ts`.
- **DEP-18:** one web test ("a protected environment's buttons are shut") replaced by its opposite, because the task removes that behaviour.
- **DEP-19:** `packages/gitlab/src/deployments.test.ts` key list gained `pipelineUrl`; `notify.test.ts`'s `world()` helper also subscribes to the new event.
- **DEP-21:** the `live()` helper in `deployments.test.tsx` took an optional argument; callers without one are unchanged.
- **DEP-22:** feature 30's Add environment dialog had its buttons clipped (nothing caught it); fixed by a shared `.drawer.centered` rule, and `shots.e2e.ts` now checks every centered dialog.

## Gate, stated plainly
- As of DEP-22, the last task that changed code: Biome clean (the one existing info in `apps/api/src/limits.test.ts`); `bun run typecheck` clean; `packages`, `apps/api` and `apps/cli` **5633 pass, 5 skip, 0 fail**; `apps/web` **841 pass, 0 fail**; `bun run e2e` 9 of 9; `demo:shots` 2 of 2 (the card and both Promote dialogs read at 1280 and 390, light and dark); `demo:align` 4 of 4; `demo:keys` 1 of 1.
- DEP-23 changed only docs and planning files. Biome and typecheck were rerun clean, and the two tests that read docs pass; the full suites were not repeated.
- **`bun run check` as one command was not run.** The steps were run one by one, so I cannot say that command exits 0. In earlier features it exited 1 on two known failures (`apps/cli/src/auth.test.ts` and `packages/db/src/stacks.test.ts`); both passed in this feature's runs, which suggests they are flaky, not fixed.
- `apps/api/src/worker-main.test.ts` is flaky under load; it passed in every run recorded here.
- Mutation checks: every task that added logic has a list of mutations that were shown failing in its LOG entry (for example, DEP-17's protected check off failed 6 tests).

## Reviews
- **Security (by hand, DEP-23):** nothing that stops delivery. Four findings in the DEP-23 LOG entry; the one that matters is below.
- **Code review (by hand):** the working tree mixes features 14 to 31, so a diff for 31 alone cannot be taken; the files the feature owns were read instead. The `/code-review` and `/security-review` skills were not run.
- **The one that matters: the approval binds the platform, not GitLab.** Anyone who can run a pipeline in the GitLab project can set `ORCH_DEPLOY_ENV` and `ORCH_DEPLOY_SHA` and deploy with no approval from here. GitLab's protected environments stop that, and `docs/deployments.md` says so. Closing it from the platform's side means the template asking the API for an approval, which is a design change.

## Not checked
- **Nothing was run against a real GitLab.** Several GitLab facts are assumed from its documentation and a mock (DEP-2's LOG entry lists them, including that `deployable.pipeline.web_url` exists on the deployments answer).
- The template's `rules` (the mock does not evaluate them), the health check and the restore of the previous build in a real runner.
- A project with hundreds of deployments or environments (the numbers read the newest 10,000 outcomes; the card reads one environments query per environment).
- Safari and Firefox.

## Left out, on purpose
- Real deploy targets (the template runs the project's own deploy script); progressive delivery, canaries and approvals by team or schedule; deployment to a cluster from the platform (D2 keeps cloud credentials out).
- The first real promotion, the template on a real GitLab and ticking "Deployment events" on a real webhook: human gates.

## Follow-ups for your decision
1. **ADR-0020 and D14 are Proposed.** Everything above is built on the recommended answers; accept, amend or reverse them in `docs/adr/0020-deployments.md`.
2. **The approval gap above.** Accept it (and rely on GitLab's protected environments) or have the template check an approval.
3. **Real GitLab:** tick "Deployment events" on the webhook, and run one promotion through a sandbox project to confirm DEP-2's assumed facts.
4. **Access answer has no project role.** Refresh, Promote, Roll back, Approve and Reject cannot be hidden from someone who may not use them; the API refuses and the card shows the reason. Fixing it adds project actions to `GET /organizations/:orgId/access` (authz model: needs your go).
5. **An approval can be left unspent beside a started pipeline** if the platform's commit fails after GitLab accepted. Needs a GitLab-side idempotency key.
6. **The dry run writes an audit row** (DEP-12, 14, 15); say if it should not.
7. **CLI choices:** `--json` and not `--format`; approve and reject take `<environment> <request-id>`; `ask` exits 0.
8. **Numbers:** a median rounded to whole seconds, window edges inclusive, the window label only in a hover (touch screens do not see it), 30 days fixed.
9. **Cut-D shortcuts:** the approval's subject is `{sha}` and `deploy` is not in `APPROVALS` kinds; no database check that the sha is a known build; only the oldest 20 approvals of an environment are looked at.
10. **Layout:** a centered dialog taller than the window scrolls its footer away (none is today); the layout journey does not check the card (the demo shots do).
