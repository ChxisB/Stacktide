# 07 CLI - Tasks

### CLI-1 - Scaffold and binary build  `[ ]` M - deps: API-5
Do: `apps/cli` command router (`util.parseArgs` or a tiny lib - decide, justify), `--version`, `--json`, config file loader (0600), `.orch.json` discovery, `bun build --compile` script.
Done when: `orch --version` runs from the compiled binary; config-file permission check has a test.

### CLI-2 - Login, whoami, logout  `[ ]` M - deps: CLI-1, AUTH-4
Do: browser login with loopback callback and a paste-token fallback; store the token; `whoami` prints principal and org.
Done when: tests against a stubbed server cover success, denied login, expired token and the token never printed.

### CLI-3 - Pull, export, push  `[ ]` M - deps: CLI-2, VAR-4
Do: `pull`/`export` in dotenv, json, shell formats; `push` with a diff preview and confirmation (`--yes` for CI).
Done when: tests cover each format's quoting/escaping edge cases and that `push` previews without sending values to the terminal.

### CLI-4 - `run --`  `[ ]` S - deps: CLI-3
Do: spawn the command with the resolved environment, forward signals, return its exit code.
Done when: tests cover exit-code passthrough, SIGTERM forwarding and that nothing is written to disk.

### CLI-5 - CI mode  `[ ]` S - deps: CLI-4, AUTH-6
Do: `orch ci login` reads the job's `id_token`, exchanges it, keeps the short-lived token in memory/env for the job.
Done when: tests cover success and wrong-audience failure; docs snippet for `.gitlab-ci.yml` `id_tokens`.

### CLI-6 - Sync and pipeline commands  `[ ]` S - deps: CLI-2, SYNC-6, PIPE-6
Do: `orch sync plan|apply`, `orch pipeline detect|setup <template>` as thin wrappers.
Done when: golden-output tests with the typed client stubbed.

### CLI-7 - Release binaries  `[ ]` S - deps: CLI-1, FND-6
Do: CI job building all targets, checksums, and an install script that verifies them.
Done when: a pipeline produces four binaries plus `SHA256SUMS`, and the install script rejects a tampered binary in a test.
