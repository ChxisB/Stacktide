# 02 Auth and RBAC - Tasks

### AUTH-1 - GitLab OAuth login and sessions  `[x]` M - deps: GL-1, API-3
Do: Authorization-code + PKCE flow against the configured GitLab; upsert user; server-side session with secure cookie; logout; state/nonce validation.
Done when: tests against the mock GitLab cover happy path, bad `state`, replayed code and expired session.

### AUTH-2 - Role model and `can()`  `[ ]` S - deps: API-2
Do: Role/permission tables in code (not DB) and a pure `can(principal, action, resource)`.
Done when: a table-driven test covers every role x action pair; unknown action denies.

### AUTH-3 - Authorization middleware and guard coverage  `[ ]` M - deps: AUTH-1, AUTH-2
Do: Replace the dev principal stub; route-level `guard(action)`; unauthenticated -> 401, unauthorised -> 403 (404 where existence must not leak).
Done when: a test enumerates every registered route and fails if any lacks a guard or an explicit `public` marker.

### AUTH-4 - API tokens  `[ ]` M - deps: AUTH-3
Do: `api_tokens` table; create (shown once), list, revoke; hashed storage with lookup prefix; scopes; expiry; `last_used_at`.
Done when: tests prove the plaintext is never stored or logged, expired/revoked tokens fail, and scopes narrow access.

### AUTH-5 - GitLab membership to role mapping  `[ ]` M - deps: AUTH-3, GL-2
Do: Map GitLab group/project access levels to platform roles; cache with TTL; fail closed when GitLab is unreachable.
Done when: tests cover each access level, cache expiry and the fail-closed path.

### AUTH-6 - CI OIDC exchange  `[ ]` M - deps: AUTH-3, GL-1
Do: `POST /auth/ci/exchange` verifies the `id_token` (JWKS fetch + cache, `iss`, `aud`, `exp`, `nbf`), maps claims to a project/environment-scoped ci principal, returns a short-lived token.
Done when: tests with locally signed JWTs cover valid, wrong `aud`, wrong `iss`, expired, unknown project and unprotected-ref-to-protected-env cases.
