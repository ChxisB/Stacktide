# Self-hosting

Runs the platform on one machine with Docker Compose (OPS-2): Postgres, a one-shot `migrate`, the `api`, the
`worker` and the `web` page, all from one image (`Dockerfile`; commands `api`, `worker`, `migrate`, `web`).

## First run

You need Docker with Compose v2, a GitLab where you can register an application, and a host name with TLS in front
of the machine (any reverse proxy; the stack itself listens on `127.0.0.1` only).

1. **Get the files.** Clone the repository. The image comes from `ghcr.io/chxisb/stacktide`; to build it from the
   checkout instead, add `--build` to the `up` command in step 6.
2. **Make the settings file.** `cp deploy/.env.example deploy/.env` (git-ignored; never commit it).
3. **Generate the secrets.**
   `openssl rand -hex 24` for `POSTGRES_PASSWORD`; `echo "k1:$(openssl rand -base64 32)"` for `ORCH_MASTER_KEYS`.
   **Store the master key somewhere other than this machine**: it is not in the database or in a backup, and without it
   every stored secret is gone ([runbook](runbook-keys-and-backup.md) covers backup, restore and rotation).
4. **Register a GitLab application** (GitLab > your user or group > Settings > Applications): confidential, scope
   `read_user`, redirect URI `https://<your host>/auth/callback`. Put its id and secret in `GITLAB_OAUTH_CLIENT_ID`
   and `GITLAB_OAUTH_CLIENT_SECRET`, the GitLab address in `GITLAB_URL` and the redirect URI in
   `GITLAB_OAUTH_REDIRECT_URI`. An `https` redirect URI makes the session cookies `Secure`.
5. **Decide who holds a role.** Roles come from GitLab membership: create a token with scope `read_api` that belongs to a
   member (or an admin) of every group and project you will link, and set it as `GITLAB_MEMBERSHIP_TOKEN`. Put your
   GitLab user id (`https://<gitlab>/api/v4/user`, field `id`) in `ORCH_PLATFORM_ADMIN_GITLAB_IDS`: only these users can
   create the first organization.
6. **Start it.** `docker compose -f deploy/compose.yml up -d`. `migrate` runs first and exits; `api` and `worker` start
   once it succeeded.
7. **Sign in.** Open `https://<your host>/` and sign in with GitLab. If the TLS proxy sits in front of the web page, set
   `ORCH_TRUSTED_PROXY_HOPS=2` (the web page itself is one hop) so rate limits count real clients.

`deploy/smoke.sh` runs steps 2 to 7 with throwaway values and a placeholder GitLab address, and checks everything up to
the redirect to GitLab's sign-in page. It does not sign in: that needs the real application from step 4.

Which GitLab it works with, and what each connection's token needs: [forges.md](forges.md).

## Settings

Set in `deploy/.env`. "Used by" is the process that reads it; `DATABASE_URL`, `HOST`, `PORT`, `NODE_ENV` and the image
are set by the compose file and the image, not by you.

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `POSTGRES_PASSWORD` | compose | none, required | Password of the `orch` database user. |
| `ORCH_MASTER_KEYS` | api, worker, migrate | none | Keys secrets at rest are sealed under, newest first (`k2:<base64>,k1:<base64>`). Unset: connections cannot store secrets. A list that does not parse stops the start. |
| `GITLAB_URL` | api, worker | none | Your GitLab. With the next three, all or none. |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | api | none | The GitLab application. |
| `GITLAB_OAUTH_REDIRECT_URI` | api | none | `https://<host>/auth/callback`. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI` | api | none | Sign in with GitHub, all three or none: an OAuth app on github.com asking `read:user`, redirect `https://<host>/auth/github/callback` (https, or http on loopback only, and exactly that path, or the API will not start). Needs `ORCH_MASTER_KEYS`, because roles are read through the tokens of the projects' GitHub connections; a person with no role in any linked repository or GitHub organization is refused. Works without the GitLab settings. See [forges.md](forges.md). Unset: `/auth/github/*` answers 503. |
| `ORCH_SSO_REDIRECT_URI` | api | none | `https://<host>/auth/sso/callback` (https, or http on loopback only, and exactly that path, or the API will not start): turns on sign-in through an organization's identity provider ([ADR-0016](adr/0016-external-identity-providers.md), set-up in [sso.md](sso.md)). Works without the GitLab settings; an `https` address makes the session cookies `Secure`. Unset: `/auth/sso/*` answers 503. |
| `GITLAB_MEMBERSHIP_TOKEN` | api, worker | none | `read_api` token that decides who holds a role. Unset: nobody does. |
| `ORCH_PLATFORM_ADMIN_GITLAB_IDS` | api | none | GitLab user ids (comma separated) that may create organizations. |
| `GITHUB_MEMBERSHIP_TOKEN` | api | none | A GitHub token with `read:org` (FRG-34), owned by a member of every GitHub organization an organization here is linked to. It reads who owns or belongs to them; without it a GitHub link gives nobody a role. Needs the three `GITHUB_OAUTH_*` settings. |
| `ORCH_PLATFORM_ADMIN_GITHUB_IDS` | api | none | GitHub user ids (comma separated, `https://api.github.com/user`, field `id`) that may create organizations and sign in with no role. A list of its own: a GitLab id never counts here. |
| `ORCH_CI_AUDIENCE` | api | none | The `aud` a CI job's `id_token` asks for. Unset: the token exchange answers 503. |
| `ORCH_API_URL` | api, worker | none | Where CI jobs reach this API. The API needs it to start the apply of a stack whose state is on the platform. (The web container has its own, set by the compose file.) |
| `ORCH_HELPER_IMAGE`, `ORCH_POLICY_IMAGE` | worker | none | Images with `orch`, `curl`, `jq` (and `tar`, `conftest` for policy) for the jobs the worker generates ([iac.md](iac.md)). |
| `ORCH_COST_IMAGE` | worker | none | An image with `infracost` and `jq`, for the estimate job of a stack a cost limit reaches ([iac.md](iac.md)). |
| `ORCH_TERRAGRUNT_IMAGE`, `ORCH_TERRAFORM_IMAGE`, `ORCH_TOFU_IMAGE`, `ORCH_DNSCONTROL_IMAGE` | api, worker | none | Image repositories (no tag) for stacks of that tool. A DNS zone's apply, and its manual import job, need `ORCH_DNSCONTROL_IMAGE`: an image with `dnscontrol`, `jq` and `wget` (and `orch` for a zone with an `environment`). |
| `STACK_DRIFT_CHECK_SECONDS` | worker | 3600 | How often stacks are looked at for drift. 0 is off, otherwise at least 60. |
| `AUDIT_PURGE_SECONDS` | worker | 3600 | How often events past their retention are deleted. 0 is off, otherwise at least 60. |
| `CHANGE_REQUEST_EXPIRE_SECONDS` | worker | 300 | How often undecided change requests are closed. 0 is off, otherwise at least 60. |
| `AUDIT_FORWARD_SECONDS` | worker | 30 | How often the audit log is handed to its sinks. 0 is off, otherwise at least 10. |
| `ORCH_GUARDRAILS_OFF`, `ORCH_PRODUCTION_SCOPES` | api, worker | none | Guardrail rules to switch off, and the names of production scopes ([guardrails.md](guardrails.md)). |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | api | none | The platform's own AWS identity, used only to assume the role a connection names ([aws-targets.md](aws-targets.md)). |
| `ORCH_METRICS_TOKEN` | api | none | `Authorization: Bearer` value for `/metrics` (32+ characters). Unset: `/metrics` answers 404. |
| `ORCH_CORS_ORIGINS` | api | none | Other browser origins allowed to call the API ([hardening.md](hardening.md)). |
| `ORCH_MAX_BODY_BYTES` | api | 2097152 | Largest request body (1 to 64 MiB). |
| `ORCH_TRUSTED_PROXY_HOPS` | api | 0 (sample file: 1) | How many proxies append the client address. The web page is one; a TLS proxy in front is another. |
| `ORCH_RATE_LIMIT_SCALE` | api | 1 | Multiplies every rate limit (0.1 to 100). |
| `LOG_LEVEL` | all | `info` | `debug`, `info`, `warn` or `error`. |
| `WEB_PORT` | compose | 3001 | Host port of the web page, on `127.0.0.1`. |
| `ORCH_IMAGE` | compose | `ghcr.io/chxisb/stacktide:latest` | The image to run; pin a version (`:0.1.0`) in production. |

**Never set `ORCH_DEV_AUTH`.** It turns authentication off; the API refuses it outside development and on a non-loopback
`HOST`, so the container would not start.

## Private CA

A GitLab (or an identity provider) whose certificate comes from your own certificate authority is trusted by giving the
platform the authority's certificate. No setting of ours is needed: it is the runtime's own variable, which every
outgoing HTTPS call of the process obeys (the GitLab client, the CI token's key fetch, single sign-on discovery).

```yaml
# deploy/ca.yml, used as: docker compose -f deploy/compose.yml -f deploy/ca.yml up -d
x-ca: &ca
  environment:
    NODE_EXTRA_CA_CERTS: /ca/ca.crt # the authority's certificate (or a bundle of them), PEM
  volumes:
    - ./ca.crt:/ca/ca.crt:ro
services:
  api: *ca
  worker: *ca
```

Put the certificate at `deploy/ca.crt` (the mount path is relative to `compose.yml`). `docker compose -f deploy/compose.yml -f deploy/ca.yml config` shows `api` and `worker` with the variable and the mount, and `migrate` without. The `web` and `migrate` services make no outgoing calls and need nothing. The variable **adds** to the usual roots, so
public sites still verify. The file is read once, when the process starts: restart after changing it.

**What was tried** (Bun 1.4.2, on 2026-10-22, a throwaway authority and a `localhost` certificate made by hand, nothing
of it kept): a plain `fetch` to a TLS server with that certificate fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; with
`NODE_EXTRA_CA_CERTS` set to the authority's certificate it succeeds; with it set to the wrong file it still fails; with
a file that is not there it still fails and prints one warning (`ignoring extra certs … load failed`), so **read the
log if a trusted authority is still refused**. A compiled binary (`bun build --compile`) behaves the same. A file with the
authority's certificate twice (a bundle) works. Public sites (`example.com`) verify with and without the variable.

**Not checked:** the real CLI binary against a private-CA platform address (the same variable is the expected way; a
compiled probe was checked, not the CLI); the runner's own trust, which is the runner's setting, not ours (a job that
calls the platform or GitLab over your CA needs `CI_SERVER_TLS_CA_FILE` or the runner's `tls-ca-file`; read GitLab's
runner docs for your version); a GitLab behind a CA that needs client certificates (not supported); a certificate that
is expired or for another name (still refused, as it should be).

## Upgrading and backing up

Upgrade: set `ORCH_IMAGE` to the new version and run `docker compose -f deploy/compose.yml up -d`. `migrate` runs before
`api` and `worker` restart; migrations only add. Back up the database and the master keys as the
[runbook](runbook-keys-and-backup.md) says; `deploy/backup.sh` and `deploy/restore.sh` read `DATABASE_URL`, so run them
with the database's address (`docker compose exec db ...` or a published port of your choosing).

The image's health check is the api's. `deploy/compose.yml` replaces it for `worker`, `migrate` and `web`; if you run
those commands with plain `docker run`, add `--no-healthcheck`, or the container is reported unhealthy.

## What is verified

`deploy/image-test.sh` and `deploy/smoke.sh` run in CI on every push ([ci-cd.md](ci-cd.md)). Not verified: a real
sign-in against a real GitLab application (step 4), a clean-machine run by someone following this page, and TLS (the
stack has none; the proxy does it).
