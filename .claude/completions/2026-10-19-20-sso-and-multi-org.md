# 20 sso-and-multi-org - done 2026-10-19

## What was built
- **SSO-1** ADR-0016: external identity providers. OIDC only (SAML dropped, SSO-8 deleted), one provider per organization, a person is the provider's `sub` and never the email, roles by a claim map that denies by default.
- **SSO-2** `sso_providers` (client secret sealed like a connection's, in the re-wrap and backup lists), `user_identities`, `users.gitlab_id` now nullable; `upsertUser` writes a `gitlab` identity. Migrations 0043, 0044 and, from the review, 0045 (an index).
- **SSO-3** The OIDC flow `GET /auth/sso/:slug/login` and `/callback`: authorization code with PKCE, `state` and `nonce`, the `id_token` checked against the provider's own keys; the issuer judged like a notification sink's address; no redirect followed, answers capped at 256 KB, the access token dropped.
- **SSO-4** Roles from the provider's rule map: the highest matching rule wins, no match refuses the sign-in and makes no person; the role lasts for the session (12 h) and is asked for on every request; the higher of GitLab's and the provider's role applies per organization; nobody becomes a platform admin through a provider.
- **SSO-5** Provider admin API and the Settings page: an org owner manages, an org admin reads; test, enable, disable; the issuer cannot be changed.
- **SSO-6** Organization management: an **Organizations** page (rename, members view, delete by typing the slug, create for a platform admin), `GET /organizations/:orgId/members` (action `member.read`), `/auth/me.platformAdmin`.
- **SSO-7** A person's own sign-in methods: `GET /auth/identities`, `DELETE /auth/identities/:id`, a Sign-in methods section, and linking (below).
- Docs: `docs/sso.md`, `docs/adr/0016-external-identity-providers.md`, `docs/self-host.md`, `docs/hardening.md`, `docs/adr/0006-auth.md`.

## Reviews (once over the whole feature, not per task)
- **`/security-review`: one High finding, fixed.** The link was a `GET`, so another site could start it in a signed-in person's browser and tie their account to an identity a hostile organization's provider controls (cross-tenant account takeover). It is now `POST /auth/sso/:slug/link`, which needs the live session and answers `{location}`; the web page calls it with `fetch` and then navigates. Tests and three caught mutations; docs and the ADR updated.
- **`/code-review`: 14 findings, 6 fixed test-first** (the provider no longer renames a person who has a GitLab identity; `ORCH_SSO_REDIRECT_URI` must be https or loopback and end `/auth/sso/callback`; `/auth/me.platformAdmin` follows the cookie's person; duplicate role rules are refused; the `sso_memberships` provider index, migration 0045; the web form's group field, where the fix was to keep it required and write down why), the rest declined or documented with reasons in the feature LOG (#1, #4, #6, #7, #9, #10, #12, #14).

## Results
Final `bun run check`: **EXIT 0** on the second full run (root 4917 pass, 0 fail, 2 skipped; web 300 pass, 0 fail). The first full run was `EXIT 1` on one test, `worker-main.test.ts` "answers merge request commands…", which waits a fixed 500 ms for a child process to log: it passed 3 of 3 runs alone and the rerun was green. That is the second feature in a row where this file's fixed sleeps failed a full run under load; it is not fixed (follow-up: wait for the child's log line instead of sleeping).
New dependencies: none. Migrations: 0043, 0044, 0045 (all additive).

## Invariants
The client secret is sealed (ADR-0007) and read only by `packages/db/src/sso.ts`; no secret, `sub`, email or token is in a list response, an audit row or a log (the audit rows hold role counts, not rule contents). The control plane still holds no cloud credentials. Every new mutating route declares `audit:` or `noAudit:`; every route declares a guard. Tests use a fake Keycloak-shaped provider and the GitLab mock; nothing touched a real provider or GitLab.

## Auth-model decisions (taken on the standing authorization; say so in the report)
- OIDC only; SAML is dropped. One provider per organization. No organization can require SSO in v1 (GitLab sign-in stays).
- A person is the provider's `sub`, never the email. Nothing links automatically; an identity joins an account only from a signed-in session (`POST`), and the "trusted provider with `email_verified`" path is **not built**.
- Roles come from a claim map (exact match, top-level claims, highest wins, no match is a refusal). The membership expires with the session (12 h), is asked for on every request, and ends at once when the provider is turned off. Logout does not end it early.
- Owner manages the provider, admin reads it; `member.read` is an org admin action; the member view lists SSO members only (GitLab's are GitLab's to list).
- No platform admin from a provider. The GitLab group is linked at organization creation only.
- ADR-0016 is accepted on the standing authorization. Reverse it in the ADR.

## Open decisions for you
1. **Provider-scoped sessions.** A person who deliberately links a hostile organization's provider hands it their account. The remedy (a provider-started session holds only that provider's roles, no GitLab roles, no platform admin, no token creation or identity management) reverses ADR-0016 decision 7. Not built.
2. **An organization with no GitLab group cannot be started**: nobody holds a role in it, and only an owner can set a provider up. Options: let a platform admin hold `sso.manage`, or require the group in the API.

## Deviations and limits
- The GitLab identity cannot be unlinked in v1 (the ADR allowed it). An identity held by a separate SSO-only person cannot be merged into a GitLab person.
- No RP-initiated logout. A link gives the role a full session length.
- A mistyped slug at the web login entry shows the API's 404 JSON (the link form shows it in the page).
- A known read-then-write race (`sso_incomplete`) on enable. Deleting a provider cascades its identities and memberships and leaves its people as accounts with no way in.
- An Entra `id_token` has no `email_verified` unless added; a nested claim (Keycloak's `realm_access.roles`) cannot be matched. Both are written in `docs/sso.md`.
- The identities route tests were not run red on their own; discovery is uncached; one extra indexed query per authenticated request.

## Not verified / human gates
- **The first real provider sign-in** (set up, Test, turn on, sign in with a person who has a rule). Everything was proved against a fake provider.
- The Playwright journey was not run (no browser). Real GitLab was never touched.
- Reviewers ran no code; the High finding was confirmed by reading and by tests that fail without the fix.
