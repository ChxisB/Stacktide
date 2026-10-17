# 02 Auth and RBAC - Spec
Prefix: AUTH · Milestone: M1 · Status: todo

## Goal
Every request has a principal and an authorization decision. People sign in with GitLab, machines use scoped tokens or GitLab CI OIDC - no long-lived static secrets in pipelines.

## Scope
GitLab OAuth login + sessions; role model + pure `can()`; route guards; API tokens; GitLab membership -> role mapping; CI OIDC exchange.

## Non-goals
Approvals/four-eyes (GOV), SAML/SSO, per-key ACLs.

## Design
- Principal = `user | token | ci`, with org, roles, and (for tokens/CI) scopes.
- Roles: org `owner > admin > member > viewer`; project roles `maintainer | developer | reporter`. Secret reveal needs `maintainer`. Deny by default.
- `can(principal, action, resource)` is pure and table-tested. Routes declare a guard; a test enumerates all routes and fails on any unguarded one.
- Sessions: httpOnly, Secure, SameSite=Lax cookie; server-side session rows; rotate on login.
- Tokens: 32+ random bytes, shown once, only a hash stored, prefix kept for lookup, scopes, expiry, `last_used_at`, revocable.
- CI OIDC: verify GitLab `id_token` (JWKS from the instance, `aud`, `exp`, `iss`); map claims (`project_path`, `ref`, `ref_protected`, `environment`) to a ci principal limited to that project/environment. Short-lived access token returned.
- GitLab roles are cached with a TTL; a failed GitLab lookup must fail closed.

## Acceptance
A user logs in via GitLab, can only see projects their GitLab membership allows, creates an API token that works with limited scopes, and a CI job exchanges its `id_token` for a token that can read only its own project/environment.

## Risks / human gates
Whole feature is security-sensitive: run `/security-review` on every task. Role model changes are a human gate.
