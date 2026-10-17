# 02 auth-and-rbac: done (2026-10-17)

All 6 tasks `[x]`. Gate: `bun run check` green, 613 pass + 1 skip + 0 fail (614 tests, 46 files). One local commit per task, nothing pushed.

| Task | Commit | What |
|---|---|---|
| AUTH-1 | 9e9b545 | GitLab OAuth (code flow + PKCE), `orch_login` / `orch_session` cookies, 12 h sessions with a hashed token |
| AUTH-2 | 22454fa | Role model: org roles viewer < member < admin < owner, project roles reporter < developer < maintainer, one `RULES` table, pure and total `can()` |
| AUTH-3 | f4821ce | Guard macros (`guard`, `signedIn`, `public`), deny by default, route-coverage tripwire, dev principal behind `ORCH_DEV_AUTH=1` |
| AUTH-4 | e33a1d1 | API tokens `orch_<8>.<43>`, SHA-256 stored, mandatory expiry, scopes only narrow |
| AUTH-5 | 9e8cd1a | Roles from GitLab membership (linked groups and projects), 5 min cache, fail closed with 503 |
| AUTH-6 | 8c0528b | CI `id_token` exchange: hand-rolled RS256 verification, `orchci_` tokens (<= 15 min, read-only, tied to the job's environment) |

Details, mutation results and review outcomes per task are in `02-auth-and-rbac/LOG.md`.

## Decisions to review (REVIEW-tagged in the LOG)

- **Role mapping** (AUTH-5): group Reporter -> viewer, Developer -> member, Maintainer -> admin, Owner -> owner; project Reporter -> reporter, Developer -> developer, Maintainer and Owner -> maintainer. Guest, Minimal and unknown levels hold nothing.
- **AUTH-2 open decisions**: `organization.create` needs `platformAdmin`; `project.create` and `project.delete` need org admin; project-only members cannot read the organization; `developer` rank is unused by any rule yet.
- **Organization group link is immutable** after create (no relink path) so that patching an org can never hand it to another group's members.
- **CI tokens** (AUTH-6): scopes are fixed to `project.read` and, with an environment, `environment.read`. A subject tied to an environment can do nothing else outside it. Variable-reading tasks must widen the scopes deliberately.

## Remaining risks and open follow-ups

- **Mock fidelity**: OAuth, members and JWKS endpoints are tested only against the mock GitLab; the `id_token` claim semantics (`project_id`, `environment`, `environment_protected`, `ref_protected`) come from GitLab's docs and were never seen from a real instance. The WebCrypto RS256 verifier was only tested with locally signed JWTs.
- **AUTH-1**: login cookie is unsigned; a blocked GitLab user keeps a session up to 12 h; failed sign-ins are not audited; one `orch_login` cookie at a time; the GitLab access token is not revoked on logout; `/auth/login` and `/auth/ci/exchange` are not rate limited; sessions per user are unbounded.
- **AUTH-3**: the `createApp` tripwire is untested; the body is parsed before the caller is checked; scoped tokens get 404 where their scopes cannot read; path ids are trusted because every query repeats them (every future route must keep this); `/openapi/json` is public; the `dev` script uses a POSIX inline env var.
- **AUTH-4**: no cap, rate limit or pruning of tokens per user; the list shows revoked and expired tokens forever; the owner is not in the audit row; no admin revoke of others' tokens; `last_used_at` lags by up to a minute; failed bearer attempts are not audited.
- **AUTH-5**: a GitLab outage or one bad link gives 503 for everyone with a cookie or token; one GitLab call per link per user per TTL; link and membership changes apply after up to 5 min; project links may cross organizations; the membership token must see every linked group (a silent 404 otherwise).
- **AUTH-6**: no `jti` replay protection; environment matched by slug only; the environment tie relies on routes passing `envId`; failed exchanges are logged, not audited; anyone who can run a pipeline in a registered project can obtain a `project.read` token.
- `/security-review` could not run (no remote); inline reviews are recorded per task.
- Migrations `0007` and `0008` need `bun run db:migrate` on the local dev database.
