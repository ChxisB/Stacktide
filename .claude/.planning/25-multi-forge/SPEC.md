# 25 Multi-forge - Spec
Prefix: FRG · Milestone: M5 · Status: planned 2026-10-20, awaiting approval (nothing built)

## Goal
The platform works with the three places a team keeps its code: a **self-managed GitLab**, **GitLab.com**, and **GitHub.com**. A team points an organization at one, and onboarding, variables, pipelines, runs and approvals behave the same, with what a forge cannot do said plainly instead of failing.

## Answer to "does it work today?"
Found by reading the code and docs (2026-10-20). **Nothing below was run against a real instance**; the real-GitLab contract suite has never been run (a human gate, `GITLAB_E2E_URL`).

| Case | Today | Why |
|---|---|---|
| Self-managed GitLab, one instance, https | Works as designed, unproven on a real one | A connection holds `baseUrl` + a token; `parseBaseUrl` takes any https URL (http only on loopback or with the override). Runner jobs use `$CI_API_V4_URL`. |
| GitLab.com | Works as designed, unproven; no docs | Same path with `https://gitlab.com`. `docs/self-host.md` has no GitLab.com section. |
| Different organizations on different GitLab instances | Variables, MRs, pipelines: yes. **Sign-in, membership, CI OIDC: no** | Those three read the one deployment-wide `GITLAB_URL` (`auth-config.ts`; `ORCH_CI_AUDIENCE` requires it). |
| A self-managed GitLab behind a private CA | Not supported, not documented | No TLS option in `packages/gitlab/src/client.ts`. Whether Bun honours `NODE_EXTRA_CA_CERTS` is unverified. |
| Old or Free-tier GitLab | Fails late, with a GitLab error | Believed (from memory, confirm in FRG-3): group variables need Premium, hidden variables 17.4+, `access: developer` artifacts about 16.11, `id_tokens` about 15.7. |
| **GitHub.com** | **Does not work. No code.** | 39 non-test files import `@orch/gitlab` (22 in `apps/api/src`, 12 in its routes, plus `packages/iac`, `pipelines`, `rotation`, `sync`, the web and the demo). Pipelines are rendered as `.gitlab-ci.yml`. D1, D6, D8 name GitLab. |

## Phases
- **Phase A, any GitLab (FRG-3 to FRG-8). Shippable alone.** Small: capability detection, TLS, CI-token verification and sign-in per instance, docs, a real-instance run. Needs only FRG-1 and FRG-2.
- **Phase B, GitHub.com (FRG-9 to FRG-27). Provisional.** About 19 tasks: weeks, not days. **The list is a first outline; FRG-1 (the audit) rewrites it before any of it is approved.** The size is the cost of a second forge done properly, not padding.

Recommended approval: FRG-1, FRG-2 and Phase A now; Phase B after FRG-1. If you prefer, Phase B moves to its own feature (27) and this one is "any GitLab".

## Scope
- **Forge seam.** One interface (`packages/forge`) for what the platform asks of a forge: repository and files, change requests (merge or pull request) and notes, CI runs, jobs and approvals, CI variables and secrets, membership, webhooks, the CI identity token. A GitLab adapter wraps `@orch/gitlab` unchanged; a GitHub adapter is new. Capability flags say what a forge lacks, and the UI and API refuse with a message, never a half-working button.
- **GitLab on any instance.** Version and capability detection on the connection test; private CA; CI identity and sign-in per instance; docs.
- **GitHub.com.**
  - A `github` connection (a fine-grained token first; see question 3) whose webhook secret is sealed, because HMAC needs the secret itself.
  - Onboarding from a repository URL, which opens a PR (never a push to the default branch).
  - A GitHub Actions workflow rendered for the onboarding pipeline and for stacks: plan on PR, apply on merge behind a protected environment.
  - Variables and secrets synced to Actions at repository, environment and organization scope, through a `SyncAdapter`.
  - Runs, jobs, approvals and webhooks.
  - Actions OIDC for `orch run`.
  - Terraform state defaults to the platform-hosted `state: orch` (ADR-0017), because GitHub has no managed state.

## Non-goals
- GitHub Enterprise Server (`baseUrl` stays configurable so it is a follow-up), Bitbucket, Gitea, Azure DevOps.
- Runner pools and runner listing on GitHub (self-hosted runner labels are the follow-up); GitLab keeps ADR-0015.
- Access-token rotation on GitHub (no project access tokens; an installation token lives one hour).
- DNS stacks (feature 21) and cost gates on GitHub in the first cut: refused with a message unless the generator already renders them (decided in FRG-1).
- Several forges inside one organization is allowed (a project belongs to one connection) but not specially designed for.
- Building anything before you approve.

## Design
- **Decision (ADR-0019, FRG-2; adds D14 to the ROADMAP once accepted):** the forge's own CI is the runner (D1 reads "GitLab CI **or GitHub Actions**"); D6 gains the GitHub token and Actions OIDC; D8 gains an inline workflow via PR; D9's default is the forge's managed state **for GitLab** and `state: orch` for GitHub; invariant 2 reads "all forge traffic goes through `packages/gitlab` or `packages/github`, reached through `packages/forge`". Unchanged: no cloud credentials in the control plane, plan then apply, nothing pushed to a default branch.
- **Interface from evidence, not from guesses.** FRG-1 tabulates every call the 39 files make, with the GitHub equivalent or the flag for none. That table is the interface (`docs/forge-seam.md`). `gitlabContract(label, setup)` becomes `forgeContract`, run by each adapter against its mock and, opt-in, a real sandbox.
- **Migration of callers is per area, GitLab behaviour unchanged.** Existing tests and snapshots stay green at each step; a caller moves to `forge` only with its test already passing.
- **Connections.** `connections.type` is free text (`gitlab` first, "EXT adds more without a migration"), so `github` needs no type migration. The webhook secret needs one additive column (or a sealed field): GitLab sends the secret and we keep its SHA-256; GitHub sends `X-Hub-Signature-256`, an HMAC-SHA256 of the body, which cannot be checked from a hash.
- **GitHub specifics to build for.**
  - Secrets are write-only: `PUT` with an `encrypted_value` sealed to the repository's public key (libsodium `crypto_box_seal`) and its `key_id`. So drift on a secret is only "names, and `updated_at` newer than our last write"; plain **variables** are readable and compared by value.
  - A `file` variable has no GitHub equivalent and Actions secrets cap at 48 KB: refused with a message, decided in FRG-20.
  - Scopes map: project to repository, environment to environment, organization to organization (an account repository has no organization scope).
  - Manual approval is an **environment with required reviewers**, approved through the pending-deployments API.
  - Installation or token requests are rate limited: back off on `retry-after` and `x-ratelimit-*`.
- **CI identity on GitHub.** The job asks for an OIDC token with our audience (`permissions: id-token: write`). Issuer `https://token.actions.githubusercontent.com`; claims `sub`, `repository`, `repository_id`, `ref`, `environment`, `job_workflow_ref`. **There is no "protected ref" claim** as GitLab has, so the rule for which refs and environments may read secrets is a design decision for FRG-23, and a `/security-review`.
- **Sign-in.** GitHub OAuth is not OIDC, so feature 20's SSO does not cover it. Teams on GitHub with an OIDC identity provider sign in through SSO; a GitHub-only team needs "Sign in with GitHub" (FRG-25, an auth-model change, a human gate). A second GitLab instance can use SSO too, since GitLab is an OIDC provider (FRG-6 checks that its project roles work).

## GitHub facts: verified and not
Verified on 2026-10-20 from GitHub's documentation:
- Actions OIDC issuer, the `id-token: write` permission, custom audience, the claims above.
- Secrets `PUT` with `encrypted_value` and `key_id` at repository, environment and organization scope, write-only; variables endpoints at the same three scopes, readable.
- Sealed box (`crypto_box_seal`); the guide uses `libsodium-wrappers`.
- Installation tokens last one hour. Webhook signature `X-Hub-Signature-256`, HMAC-SHA256, constant-time compare.
- Environments are available on Free for public repositories; private repositories need a paid plan.

**To confirm (FRG-1, or the task that needs it):** the JWKS URL of the OIDC issuer; the issuer for a GitHub Enterprise Cloud organization with a custom subdomain; which protection rules each plan allows on a private repository; the exact pending-deployments approval call; whether a fine-grained token may write organization secrets; the sealed-box output format against a real key.

## Invariants check
1 the token, the webhook secret and every secret value stay out of logs, audit, responses and fixtures: leak tests in FRG-10, FRG-20, FRG-21 · 2 reworded by ADR-0019 and kept: no stray `fetch` to a forge outside its package · 3 kept: the token is a connection credential like the GitLab one (ADR-0013 class), no cloud credential · 4 every new route has a guard and an audit event · 5 PR then merge then apply; delete stays opt-in · 6 a test per forge that the default branch is never written · 7 tests use mocks; a real run is opt-in and a human gate · 8 migrations additive.

## Acceptance
- **Phase A:** two mock GitLabs with different issuers: an organization on each can sign in (or fail clearly), its CI token is accepted only for its own projects, and `orch run` works on both; the connection test shows the version and what the instance lacks; the docs say how to run against GitLab.com, a self-managed GitLab and a private CA. A real-instance run exists or is recorded as not done.
- **Phase B:** on the GitHub mock, from a repository URL: onboarding opens a PR with a workflow; variables sync to repository, environment and organization scope and a secret opens with the mock's own key; a stack plans on a PR and applies after a reviewer approves the environment; a workflow-run webhook with a good signature moves the run, one with a bad signature is refused; an Actions token for another repository or ref is refused. The GitLab suites pass unchanged.

## Risks / human gates
- **ADR-0019 (FRG-2)** adds a decision and rewords invariant 2.
- **Auth-model changes:** CI token verification per connection (FRG-5), Actions OIDC (FRG-23), sign-in with GitHub (FRG-25). Each gets a `/security-review`.
- **A new dependency:** libsodium for the sealed box (FRG-19), or a smaller audited implementation, justified in LOG.md.
- **Real writes:** any run against a real GitLab or GitHub (FRG-8, FRG-27) is a human gate, on a sandbox group or organization.
- **The audit may grow Phase B.** A forge call that does not map, found in FRG-1, becomes a capability flag or a new task, not a silent gap.
- **The plan limits of GitHub** (environments on private repositories) can make the approval gate unavailable for some customers; the platform must detect it and refuse to render an apply it cannot gate.
- **Nothing here was run:** every "works today" row is by reading.

## Open questions (answer at approval)
1. Approve FRG-1, FRG-2 and Phase A now, and Phase B after the audit (recommended), or split Phase B into feature 27?
2. GitHub-only teams: build "Sign in with GitHub" (FRG-25, recommended, since without it they need an OIDC provider) or require SSO?
3. GitHub credential: a fine-grained token per connection first (recommended: smallest, the same shape as the GitLab connection), or a GitHub App from the start (short-lived tokens, not tied to a person, more setup)?
4. DNS stacks and cost gates on GitHub: refused in the first cut (recommended), or part of Phase B?
5. A second GitLab instance for sign-in: through feature 20's SSO (recommended, no new auth method), or a per-instance GitLab OAuth setup?
