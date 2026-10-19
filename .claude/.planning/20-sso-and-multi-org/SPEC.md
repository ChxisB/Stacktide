# 20 SSO and Multi-org UI - Spec
Prefix: SSO · Milestone: M5 · Status: done 2026-10-19

## Goal
An organization can let its people sign in with its own identity provider (OIDC first, SAML only if you choose it), and platform admins can create and manage organizations from the UI.

## Scope
ADR; identity model change; OIDC login; role mapping and just-in-time membership; provider admin UI; org create/manage UI.

## Non-goals
SCIM provisioning, enforcing MFA ourselves, per-org custom domains, replacing GitLab OAuth (it stays; GitLab is still needed for GitLab connections).

## Design
- **Auth model change = human gate (ADR-0006).** SSO-1 writes the ADR before any code.
- **Today:** `users.gitlab_id` is NOT NULL and unique; roles come from the org's GitLab group (AUTH-5). Sign-in is GitLab OAuth only. The org switcher exists in the web shell (`OrgSwitcher`); there is **no UI to create or manage organizations**.
- **Identity model:** a user can have several identities. `users.gitlab_id` becomes nullable (additive/forward-only) and `user_identities(provider, subject)` is unique per provider; the per-org `sso_providers` row holds issuer, client id, a sealed client secret, an allowed email-domain list and the claim -> role map.
- **OIDC first:** discovery, authorization code + PKCE, state and nonce, `id_token` verified against the issuer's JWKS. The repo already verifies OIDC JWTs for CI (`id-token.ts`), so reuse that verifier. It covers Okta, Entra, Google, Auth0, Keycloak and anything OIDC-capable.
- **SAML** needs XML signature validation - a security-critical parser nobody should hand-roll - so it needs a library and a dependency approval. SSO-1 decides whether SAML is built; SSO-8 exists only if it is.
- **No automatic account linking by email.** Linking an SSO identity to an existing user needs the user to be signed in already (or the provider to be trusted and `email_verified`), otherwise a hostile or misconfigured IdP could take over an account. SSO-7 owns these rules.
- **Roles:** a claim (e.g. `groups`) maps to org roles; no mapping match = no access (deny by default); membership is re-evaluated at every login so a removed group removes access.
- **Multi-org UI:** create, rename and delete organization (platform admin), member and role view, link GitLab group. The API already supports organizations; this is UI plus the checks the UI needs.

## Acceptance
A fake IdP signs a user in; the user lands in the right org with the mapped role; a user outside the mapped groups is refused; a second login after a group change updates the role; a forged `id_token` (wrong issuer, audience, nonce, expired, bad signature) is refused; an existing GitLab user is never silently linked by email; a platform admin creates an org in the UI and switches to it.

## Risks / human gates
- SSO-1 (ADR), SSO-3/SSO-4/SSO-7 (`/security-review`), any SAML dependency, and the first real IdP sign-in are human gates.
- Changing `users` touches every session and membership query: run the full authz suite on SSO-2.

## Open questions
1. Which IdP do you actually need first (Okta, Entra, Google, Keycloak)? It decides the test fixtures.
2. Is SAML required, or is OIDC enough?
3. Should an org be able to *require* SSO (disable GitLab sign-in for its members)?
