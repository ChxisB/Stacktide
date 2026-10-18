# Guardrails

Two rules the platform checks before it plans a sync, so a mistake is a plan error, not a variable in the wrong place.
They are on by default.

| Rule | Breaks when |
|---|---|
| `production-secret-protected` | a **secret** would be written to a production scope of a target that is not protected |
| `production-variable-protected` | a **plain variable** would be written to a production scope of a target that is not protected |

A target is protected when its config says `"protected": true` (GitLab variables: `{ "project": "g/p", "protected": true }`).
Set it through the API (`PATCH` the target's `config`); neither the web app nor the CLI edits a target's config.
A target that says nothing is unprotected.

## What "production" is

A scope is production when its name is one of `production`, `prod` (the GitLab `environment_scope`). The GitLab scope may be a
glob: `prod*` and `production/*` reach `production`; a bare `*` (all scopes) does **not**, because every variable would break
the rule. Change the names with `ORCH_PRODUCTION_SCOPES` (comma list of literal names, no wildcards; empty means the default).

## Where it applies

- **Plans** (`POST /runs`, scheduled auto-sync, drift runs): a violation is `422 guardrail_violation`; the message names the
  rule, the key and the scope (never a value), at most ten of them. Auto-sync and drift log it and do not plan.
- **Pipelines** (`orch pipeline setup`, the web app, fleet upgrades): the pipeline checks each GitLab-variables target of the
  project that maps an environment to a production scope. It cannot tell a secret from a variable, so it uses
  `production-variable-protected` only. `validate` lists them under `violations`; apply and the fleet upgrade refuse
  with `422 guardrail_violation`, and the web app disables "Create merge request".

## Switching a rule off

`ORCH_GUARDRAILS_OFF=production-secret-protected,production-variable-protected` (API and worker; a comma list of rule ids).
An unknown id stops the process at boot. A rule that is off does nothing. The setting is instance-wide.

## Not covered

No per-organization settings, UI or audit of the setting; one target type (GitLab variables); a stored plan is not
re-checked when it is applied (its digest covers the target's config, so a config change makes it stale).
