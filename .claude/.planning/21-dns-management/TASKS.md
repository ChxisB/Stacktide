# 21 DNS Management - Tasks

### DNS-1 - ADR-0018: DNS applied runner-side  `[x]` S - deps: none
Do: write `docs/adr/0018-dns-runner-side.md`: decision (DNSControl in the runner, tokens as managed variables, the platform holds nothing), rejected alternatives (native provider adapters through `connections` as a second ADR-0013 exception; octoDNS; rebuilding external-dns), consequences (pipeline round trip, no UI record editor), why claims are a guard and the token scope the boundary. **Human gate: adds decision D13 to the ROADMAP.**
Done when: you accept or amend the ADR and the ROADMAP decisions table has the D13 row.

### DNS-2 - Spike: what DNSControl really does  `[x]` S - deps: DNS-1
Do: run DNSControl in a container with its local `BIND` provider on a fixture zone (no network, no real zone). Write `docs/dns-spike.md` and commit the captured real outputs as fixtures: `preview` format and exit codes (any machine-readable option), `check`, `print-ir` JSON (incl. the keep-unknown flag), `get-zones`, `$ENV` references in `creds.json`, default purge of unknown records, the official image name and tag scheme, and which `orch run` prefix hands the tool its credentials.
Done when: each assumption listed under "Risks" in SPEC.md is marked verified or the SPEC and TASKS are amended; fixtures exist. If the container cannot run here, say so and mark `[!]`.
Result: done 2026-10-20 with the v5.5.0 release binary (checksum verified), not a container, because Docker did not answer; see `docs/dns-spike.md`. Fixtures in `packages/iac/src/fixtures/dnscontrol/`. Tasks 4, 5, 8, 9, 10 are amended below.

### DNS-3 - `dnscontrol` stack tool  `[x]` S - deps: DNS-2
Do: add `dnscontrol` to `TOOLS` and the `stack.yml` schema (`version` required, `state` refused, `dns.prune` boolean, strict as the rest); additive migration widening `stacks_tool_check`; discovery (`scan.ts`) accepts it.
Done when: `stack.test.ts` cases (accepted, `state: orch` refused, misspelt `dns` key refused); a db test stores a `dnscontrol` stack; every existing stack and snapshot is unchanged.

### DNS-4 - Plan job and summary mapping  `[x]` M - deps: DNS-3
Do: `pipeline-gen` branch for a `dnscontrol` stack: `check` + `preview --report` job (artifacts: the report JSON and the preview text, `access: developer`), and a summary job that maps the report's `correction_details` to the existing summary shape (`address` = `<zone>/<name>/<TYPE>`, actions only; a line that does not parse is one `update` of `<zone>`, "Ensuring zone" is a `create` of `<zone>`) and posts it to the same route. Image from `ORCH_DNSCONTROL_IMAGE` (repository, the stack's `version` is the tag, no `v`); the image must also hold `orch`, so the job sets `entrypoint: [""]`. `orch run -- dnscontrol ...` with no prefix. The job first checks that each `$NAME` in `creds.json` is a set, non-empty variable (an unset one does not fail in the tool) and stops with a fixed message. Never `--allow-fetch`; never forward tool error text (it echoes values). Documented in `docs/iac.md`.
Done when: pipeline-gen snapshot for a DNS plan; terraform snapshots byte-identical; a canary TXT value is in no generated YAML and no summary fixture; the plan-summary route accepts the generated summary unchanged.

### DNS-5 - Apply job with change-set guard  `[x]` M - deps: DNS-4
Do: apply job for a DNS stack: re-run `preview --report`, compare a digest of its sorted `correction_details` (taken in the runner, values included, nothing posted) with the plan job's artifact, stop with a fixed message on a difference, else `push`. **`/security-review`.**
Done when: snapshot; a shell-level test of the guard script (same set pushes, a changed set does not); the apply preconditions of IAC-8 still hold for DNS stacks.

### DNS-6 - Zone claims  `[x]` M - deps: DNS-3
Do: additive migration `dns_zones`; repo; `/organizations/:orgId/dns/zones` list, create, delete (reporter reads, org admin writes, audited `dns_zone.*`); zone name validation (lowercase labels, no wildcard, punycode, 253 chars); a project's claims go with it. **`/security-review`.**
Done when: db and route tests; a duplicate claim is 409; the guard-coverage test passes; the audit rows hold zone and stack only.

### DNS-7 - Apply gates: claims and deletes  `[x]` M - deps: DNS-5, DNS-6
Do: at summary ingest a DNS run that names an unclaimed zone, or has a `delete` while the stack lacks `dns.prune: true`, is denied the way a policy `deny` is, with a fixed reason naming the zone, never a value; apply is refused; the MR note shows why. **`/security-review`.**
Done when: tests for unclaimed zone, delete without prune (denied), delete with prune (allowed), a zone with no changes (not checked); canary: no value in the reason.

### DNS-8 - `orch dns init` scaffold  `[x]` S - deps: DNS-3
Do: CLI command writing `stack.yml`, `dnsconfig.js` (`NO_PURGE` on each domain: unmanaged records kept) and `creds.json` (`$VAR` references only) into a directory, refusing to overwrite, validating the provider name, and printing the variable names to create.
Done when: CLI tests: files written, overwrite refused, `creds.json` holds no value, bad provider name refused; the generated `stack.yml` passes the DNS-3 schema.

### DNS-9 - Import job  `[x]` S - deps: DNS-4, DNS-8
Do: a manual `import:<stack>` job in the generated pipeline running `get-zones --format=js`, artifact = starting config (the draft gets `NO_PURGE` and a fixed provider call added, since the raw draft has neither), never auto-run.
Done when: snapshot; a fixture round trip: the imported config planned against the same `BIND` zone gives an empty plan.

### DNS-10 - Lint rules  `[x]` M - deps: DNS-2
Do: pure `lintZones(ir)` in `packages/iac` with the five v1 rules (`spf-single`, `dmarc-with-mx`, `caa-apex`, `ttl-range`, `keep-unknown`), findings = rule, severity, address, never a value. `spf-single` is needed because `dnscontrol check` accepts two SPF records; `keep-unknown` reads the domain's `keepunknown` flag, absent when the zone purges.
Done when: a good zone and a bad zone per rule from the DNS-2 `print-ir` fixtures; a canary test that no finding carries a value.

### DNS-11 - Lint wiring  `[x]` M - deps: DNS-7, DNS-10
Do: `orch dns lint` reads `print-ir` JSON on stdin and prints the findings JSON; the plan job runs it and the summary carries an optional bounded `lint` block (route bounds raised together with the generator, as `MAX_LISTED` is); an `error` finding denies apply (DNS-7 path); the MR note shows counts per severity.
Done when: route accepts and bounds `lint`; MR note snapshot; an `error` denies apply, a `warn` does not; canary test.

### DNS-12 - Drift for DNS stacks  `[x]` S - deps: DNS-4
Do: check that the scheduled drift run (`stack-drift.ts`) treats a non-empty DNS summary as drift and nothing else needs to change; fix what does not.
Done when: a drift test with a DNS summary: empty -> in sync, one change -> drifted, notification once per episode.

### DNS-13 - Hermetic end-to-end with `BIND`  `[x]` S - deps: DNS-5
Do: opt-in test (`ORCH_E2E_DNSCONTROL=1`, binary on the path, like `vault-kv.e2e.test.ts`) that runs the generated plan and apply scripts against DNSControl's local `BIND` provider: add a record, plan, apply, plan again.
Done when: the test passes locally with the binary and is skipped without it; the second plan is empty.

### DNS-14 - Docs  `[x]` S - deps: DNS-9, DNS-11
Do: `docs/dns.md`: set-up (scaffold, import, claim, variables, first MR), token scoping for Cloudflare and Route 53 (the real boundary), prune, lint rules, coexistence with external-dns, what the platform deliberately does not do. Link from `docs/iac.md` and the README.
Done when: the doc's commands match the CLI help (a test greps them); links resolve.

### DNS-15 - UI: zone claims  `[x]` S - deps: DNS-6
Do: the organization page lists the zone claims (any member reads; an admin claims and releases, release asks first). Split from the first draft of this task on 2026-10-20: the web app has no screen for plan runs or stack lists, so the run half is DNS-16.
Done when: component tests incl. empty state, a non-admin, a zone claimed already and the release that asks first; the journey test is still green.

### DNS-16 - UI: DNS stacks in plan runs  `[x]` S - deps: DNS-7, DNS-11, DNS-15
Do: the run DTO says which stack is a DNS zone and carries the policy verdict (rule names only) and the lint counts; the Status page lists a project's plan runs with their stacks, a zone labelled as one, and a denied stack showing its reasons.
Done when: API test that the DTO carries them and no value; component tests incl. empty state and a denied zone; the journey test is still green.
