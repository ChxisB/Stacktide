# 20 SSO and Multi-org UI - Tasks

### SSO-1 - ADR: external identity providers  `[x]` S - deps: AUTH-5
Do: write the ADR amending ADR-0006: OIDC first, whether SAML is built, the identity model, linking rules, role mapping, whether an org can require SSO. **Human gate (auth model).**
Done when: you accept or amend it; SSO-8 is kept or deleted by that decision.

### SSO-2 - Identity schema  `[x]` M - deps: SSO-1
Do: forward-only migration: `users.gitlab_id` nullable, `user_identities(provider, subject)` unique, `sso_providers` per organization (issuer, client id, sealed client secret, domain list, role map); the key re-wrap list gains the new table. (`/security-review` runs once over the feature's diff.)
Done when: the whole authz and membership suites pass unchanged; existing users get a `gitlab` identity by backfill; the sealed secret is not readable from the table; the structural re-wrap test lists the new table.

### SSO-3 - OIDC login flow  `[x]` M - deps: SSO-2, AUTH-1
Do: discovery, authorization code + PKCE, state and nonce, `id_token` verification with the existing JWT verifier; session created like AUTH-1; rate-limited. (`/security-review` runs once over the feature's diff.)
Done when: a fake IdP passes; wrong issuer, audience, nonce, signature, expiry, a replayed code and a missing `email_verified` are each refused; no token or code appears in logs or audit.

### SSO-4 - Role mapping and just-in-time membership  `[x]` M - deps: SSO-3, AUTH-5
Do: claim -> org role map; the first login creates membership; every login re-evaluates it (removed group = access removed); no match = refused. (`/security-review` runs once over the feature's diff.)
Done when: tests for first login, role change, group removal, no match, and a claim that tries to grant a role the map does not list.

### SSO-5 - Provider admin API and UI  `[x]` M - deps: SSO-4, UI-8
Do: org-admin routes and settings page to create, test (a dry discovery fetch), enable and disable a provider; every change audited; client secret write-only.
Done when: authz and leak-canary tests; the secret is never returned; a disabled provider cannot sign anyone in.

### SSO-6 - Organization management UI  `[x]` M - deps: UI-8
Do: platform-admin screens to create, rename and delete organizations, link a GitLab group, and a member/role view; the switcher picks up new orgs.
Done when: component tests per screen and role (non-admin sees none); a delete shows what it removes and needs typed confirmation; journey test still green.

### SSO-7 - Account linking and logout rules  `[x]` M - deps: SSO-4
Do: link an SSO identity only from an already signed-in session, or from a provider the org marked trusted with `email_verified`; never auto-link by email otherwise; unlink; SSO logout clears the session. (`/security-review` runs once over the feature's diff.)
Done when: takeover tests - an IdP asserting an existing user's email without verification creates a separate account or is refused, never a link.
