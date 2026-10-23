# 21 dns-management - done 2026-10-20

A DNS zone is a stack. Its records live in `dnsconfig.js`, a merge request shows which records would be created, changed or deleted (never a value), and the apply pushes them. DNSControl runs in the CI runner: **the platform never calls a DNS provider and never holds a DNS credential** (ADR-0018, decision D13). The platform adds the gates: a zone must be claimed, a delete is opt-in, a broken config is refused. Nothing is committed.

## What was built
- **DNS-1** ADR-0018 (accepted; adds D13). **DNS-2** a spike against the real DNSControl 5.5.0 and its `BIND` provider (`docs/dns-spike.md`, 16 findings).
- **DNS-3** `dnscontrol` as a stack tool (migration 0049). **DNS-4** the generated plan job and the summary mapping: counts, zone/name/type/action of each change, no values. **DNS-5** the apply job with a change-set guard: the apply pushes only what the plan previewed, else it pushes nothing.
- **DNS-6** zone claims (table, `POST/GET /organizations/:orgId/dns/zones`, `DELETE .../:zoneId`, audited; migration 0051). **DNS-7** the apply gates: unclaimed zone, delete without `dns.prune`, truncated plan, invalid zone name (migrations 0050, 0052).
- **DNS-8** `orch dns init`. **DNS-9** the manual `import:<stack>` job. **DNS-10/11** the lint (`spf-single`, `keep-unknown` deny; `dmarc-with-mx`, `caa-apex`, `ttl-range` warn) and its wiring into the summary and the verdict (migration 0053).
- **DNS-12** drift for DNS stacks, and DNS-only repos are planned at all. **DNS-13** an opt-in end-to-end test with the real binary and `BIND`. **DNS-14** `docs/dns.md`, with tests that run its commands and check its links and reasons.
- **DNS-15** the Organizations page lists and manages zone claims. **DNS-16** the run DTO carries `dns` and `policy` per stack, and the Status page has a "Plan runs" card: a zone is labelled, with its lint and, when denied, the reasons by name.

## Gate, stated plainly
- Format, Biome and typecheck (incl. web): clean (one Biome info in `limits.test.ts`, which this work did not touch).
- Root suite (packages, api, cli): 5282 pass, 5 skip (four opt-in real-binary tests and the e2e), **2 fail**, both known and unrelated: `apps/cli/src/auth.test.ts` "answers once: a second request with the right state is too late", and `packages/db/src/stacks.test.ts` "a stack that is still there keeps its id…" (a strict `updatedAt` comparison).
- Web suite: 420 pass, **1 fail**: `apps/web/src/identities.test.tsx` "giving one up asks first…" (takes 17 s or more; also fails run alone; cause not found; it is not touched by this feature).
- `bun run e2e`: 3 of 3 (the journey and both layout journeys at 390px).
- Docker has stopped answering, so every suite ran against a throwaway native Postgres 18 on 5433. `bun run check` has therefore **not been seen green end to end**.
- No test was weakened, skipped or deleted. Where a change broke a test's premise (below) the test's setup was changed, and that is said.

## Reviews
- `/security-review`, by hand per task (DNS-5, 6, 7 as the spec asks, and every task after): no finding at 8/10 or above. Values never reach the summary, the note, the lint findings, the audit or an error (canary tests in DNS-4, 7 and 11, and in the DTO).
- `/code-review` over DNS-4..16: 11 findings, each checked. **Three fixed**, details in LOG.md:
  1. A claim released after a plan was judged did not stop that plan's apply. The apply now checks the claims as they stand.
  2. Beside it: a zone whose summary never arrived could be applied with no gate. It now waits (`policy_pending`). **This changes what DNS-5 accepted**; the DNS-5 tests' world now gives the zone a clean summary and verdict by default.
  3. A stray duplicate `runs.tsx` at the repository root, made by one of my own mutation-check commands, removed. And the plan-state map is typed by `RunState`.
  The rest were left on purpose (LOG.md has each reason); the ones that are yours to decide are under Questions.

## Questions for you (design choices, not defects)
1. **Lint absent:** when `orch dns lint` is missing from the helper image or the plan job predates `ir.json`, the summary has no lint and the gate passes it. Should that be a visible warning, or a denial?
2. **Unknown DNSControl wording:** a preview line the filter does not know counts as an update. Fail closed (a plan with such a line is denied) or keep it?
3. **DNSControl older than 5:** the lint reads no records and the note says "no findings". Refuse `version` below 5 in `stack.yml`, or report "not readable"?
4. **Drift runs** carry no zone marker or verdict (they never apply). Worth a task so the Plans list labels a zone in a drift check?

## Left out, on purpose
- A DNS record editor in the UI, other engines (octoDNS), registrar/NS delegation, DNSSEC keys, propagation checks, derived records (the SPEC's non-goals).
- Plan counts and an apply button in the Plans list: it reads, it does not act (apply stays `orch apply` in a merge request comment, or `apply_on: merge`).
- The task split: DNS-15 first asked for stack lists and a denied run's reason, but the web app had neither a stack list nor a plan-run screen, so the run half became **DNS-16** (same scope, divided). That is adding a task to an approved SPEC, which the factory rules gate; I did it under "split a task that is wrong or too big" and say so here so you can object.

## Things to know before you rely on it
- **Never run against a real provider, runner or image.** DNSControl 5.5.0 was a locally downloaded binary (checksum verified); only `BIND` ran. The official image was never pulled. How Cloudflare or Route 53 word their output, and whether their tokens scope as `docs/dns.md` says, is unverified (the permission lists are from DNSControl's pages on 2026-10-20, the Route 53 narrowing from AWS's IAM docs by recall). **The first real `push` is a human gate:** use a throwaway zone and a zone-scoped token.
- **The image:** zone apply and the import job need `ORCH_DNSCONTROL_IMAGE` to hold `dnscontrol`, `jq` and `wget` (and `orch` when the zone has an environment, and for the lint).
- **A claim is a guard, not a wall.** The repository's own code runs in the job; the token's scope is the boundary.
- **Projects imported before this** need a re-import (the platform plans only projects whose import saw Terraform, Terragrunt or a `dnsconfig.js`).
- **Import residuals:** split-horizon names are skipped, only a zone's first provider is read, the draft needs editing.
- **`orch dns init`** defaults to DNSControl 5.5.0; the CLI now imports `@orch/iac` at runtime (binary size not measured).
- **Migrations 0049-0053** are additive.
- Not looked at by eye in a browser: the claims card and the Plans card were tested with happy-dom and the layout journey.
- The apply's change-set digest includes DNSControl's kept-records note, so a record added at the provider between plan and apply makes the apply refuse and ask for a new plan (safe).

## Follow-ups
- Run the opt-in tests when the binary is at hand: `DNSCONTROL_BIN=<path> bun test packages/iac/src/pipeline-gen.dns.test.ts` and `ORCH_E2E_DNSCONTROL=1 DNSCONTROL_BIN=<path> bun test packages/iac/src/dns.e2e.test.ts` (not in CI).
- Stop the scratch Postgres before running `bun run dev:db`.
