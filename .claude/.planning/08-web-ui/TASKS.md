# 08 Web UI - Tasks

### UI-1 - Shell, auth, design tokens  `[x]` M - deps: API-5, AUTH-1
Do: `apps/web` Bun HTML-import app; login/logout; layout with nav; typed client wiring; light/dark tokens; error boundary.
Done when: signed-out users land on login; signed-in users see the shell. **Check the visual direction with the user before UI-2.**

### UI-2 - Connect and import wizard  `[x]` M - deps: UI-1, GL-7
Do: add a GitLab connection, browse groups/projects, import selected, show detected types; first-run checklist.
Done when: component tests cover bad token, empty list and partial import errors.

### UI-3 - Variables matrix  `[ ]` M - deps: UI-1, VAR-4
Do: environment matrix (rows = keys, columns = environments) with inherited/overridden markers, add/edit/delete, masked secrets with audited reveal that auto-hides.
Done when: tests cover reveal flow, inheritance display and delete confirmation.

### UI-4 - Variable history and import  `[ ]` M - deps: UI-3, VAR-5, VAR-6
Do: version history drawer with rollback; `.env` paste/upload import with dry-run preview.
Done when: tests cover rollback confirmation and that the import preview shows key names and conflicts, not secret values.

### UI-5 - Sync panel  `[ ]` M - deps: UI-1, SYNC-6, SYNC-8
Do: per project/environment targets, plan preview table, apply with confirmation, drift badge, last-sync status.
Done when: tests prove the plan view has no value-rendering path for secrets.

### UI-6 - Pipeline setup wizard  `[ ]` M - deps: UI-1, PIPE-4, PIPE-6
Do: detect -> select -> generated params form -> rendered diff and lint result -> Create MR; link to the MR.
Done when: tests cover missing-variable warnings, lint errors blocking creation, and re-run updating the same MR.

### UI-7 - Pipelines dashboard  `[ ]` S - deps: UI-1, PIPE-8
Do: latest pipeline per project/environment, status, failure reason, retry.
Done when: tests cover each status and an empty state.

### UI-8 - Settings  `[ ]` M - deps: UI-1, AUTH-4, AUTH-5
Do: connections, members/roles view, API tokens (create shows once), audit log viewer once GOV-1 exists.
Done when: token creation shows the value exactly once; role-restricted screens hide for viewers.

### UI-9 - End-to-end smoke  `[ ]` M - deps: UI-6, UI-5
Do: Playwright happy path against the mock GitLab backend in CI.
Done when: the scripted journey in Acceptance passes in the pipeline.
