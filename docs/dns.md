# DNS zones as code (feature 21)

A DNS zone is a stack. Its records live in `dnsconfig.js` in your repository, a merge request shows which records would be
created, changed or deleted, and the apply pushes them. The engine is [DNSControl](https://docs.dnscontrol.org), and it runs in
your CI runner, not in the platform: **the platform never calls a DNS provider and never holds a DNS credential**
([ADR-0018](adr/0018-dns-runner-side.md)). The trade is the one every stack makes: a plan or a drift check needs a pipeline round
trip, and in return nothing in the platform can rewrite your DNS. How the jobs are built is in [iac.md](iac.md); what DNSControl
was seen to do is in [dns-spike.md](dns-spike.md).

## Set up

You need: a project imported into the platform, a GitLab runner, an image with `dnscontrol`, `jq` and `wget` (and `orch` when the
zone has an `environment`) set as `ORCH_DNSCONTROL_IMAGE` on the API and worker (see [self-host.md](self-host.md)), and the
platform's `.gitlab-ci.yml` from [iac.md](iac.md).

1. **Scaffold the zone.** In the repository:

   ```sh
   orch dns init stacks/dns/example-com --zone example.com --provider CLOUDFLAREAPI --environment production
   ```

   It writes `stack.yml`, `dnsconfig.js` and `creds.json` in that directory, and refuses to write anything if one of them exists.
   `dnsconfig.js` keeps the records it does not list (`NO_PURGE`); `creds.json` holds `$NAME` references to variables, never a value.
   `--name` (the stack's name, default the zone with dashes), `--version` (the DNSControl release, default `5.5.0`, which is also the image
   tag) and `--environment` (the environment that holds the credentials) are optional. The provider type is DNSControl's own, in capitals.
   For Cloudflare and Route 53 it writes the credential fields too; for any other provider you add its fields to `creds.json`, each as a
   `"$NAME"` reference.
2. **Create the credentials as secret variables** in the environment `stack.yml` names, one for each `$NAME` the command printed (for
   Cloudflare `CF_API_TOKEN`; for Route 53 `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`). The job gets them through `orch run`, under their own
   names, and a `$NAME` that is unset or empty stops the job before DNSControl runs. Scope the token as described below.
3. **Import the project again** if it was imported before DNS zones were supported: the platform plans, applies and drift-checks only
   projects whose import saw Terraform, Terragrunt or a `dnsconfig.js`, and the import reads file paths, so a repository that only has
   zones is not planned until it has been imported with one.
4. **Start from the zone you have.** For a zone that already exists at its provider, the pipeline has a manual `import:<stack>` job (only when
   `ORCH_DNSCONTROL_IMAGE` is set). It reads each zone `dnsconfig.js` names with `dnscontrol get-zones` and keeps a draft per zone in the
   `import/` artifact. Read it, put it in `dnsconfig.js`, and commit. The draft lists every record of the zone and has `NO_PURGE`, so the
   first plan of it is empty. It needs editing: split-horizon names are skipped, only the first provider of a zone is read, and the job never
   writes to the provider or the repository. The artifact holds record values, so only developers can open it.
5. **Claim the zone.** An organization admin says which project and stack may manage it:

   ```sh
   curl --request POST "$ORCH_API_URL/organizations/$ORG_ID/dns/zones" \
     --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" \
     --data '{"zone": "example.com", "projectId": "<the project id>", "stack": "example-com"}'
   ```

   A zone is claimed once per organization (a second claim is `409 dns_zone_claimed`). `GET` on the same path lists the claims for any
   member and `DELETE .../dns/zones/:zoneId` releases one. Both writes are audited (`dns_zone.create`, `dns_zone.delete`; the zone, the
   stack and the project id are the whole record). The claim lives in the platform, not in the repository, so a merge request cannot make one.
6. **Open a merge request** that changes a record. The note lists the zone, the name, the type and the action of each change
   (`example.com/www/A`, `create`) and the counts, **never a value**; the values are in the merge request's diff and in the plan job's
   `preview.txt` and `report.json`, artifacts only developers can open. A maintainer applies with `orch apply` in a merge request comment,
   or the stack says `apply_on: merge`.

## What the apply checks

The platform decides at the plan's summary and **refuses the apply** (the run is `policy_denied`, and the merge request note says why) when:

| Reason | When | What to do |
|---|---|---|
| `dns-zone-unclaimed:<zone>` | The plan changes a zone this project's stack has not claimed, when the summary arrives and again when the apply is asked for (a claim released in between stops the apply). | Claim it (step 5), or take the zone out of `dnsconfig.js`. |
| `dns-delete-without-prune:<zone>` | The plan deletes a record and the stack does not say `dns: { prune: true }`. | See Prune below. |
| `dns-lint-<rule>:<zone>` | The lint found an error (below). | Fix the config. |
| `dns-plan-truncated`, `dns-lint-truncated` | The summary lists fewer changes (or findings) than its counts say, so a zone could be left unchecked. | Split the stack, or fix the findings. |
| `dns-zone-invalid` | A zone name in the plan is not a plain lowercase zone name. | Rename it. |

The reasons name the zone and never a record's name or value. A zone the plan does not change is not checked: there is nothing to harm. A zone's plan whose summary never arrived has not been judged, so the apply waits (`policy_pending`) until it is planned again.

**A claim is a guard, not a wall.** The repository's own code runs in the job, so a merge request that can change `dnsconfig.js` can try to
change what runs. The claim stops a project from managing a zone by accident or by a mistaken copy; **the real boundary is the token's scope**
(next section), because the platform cannot stop what a token can do.

## Prune

DNSControl deletes every record at the provider that the config does not list, unless the zone says `NO_PURGE`. The platform makes that an
explicit choice. `dns.prune` in `stack.yml` is false unless you say otherwise:

```yaml
name: example-com
tool: dnscontrol
version: 5.5.0
dns:
  prune: true
```

With `prune` off, a plan that deletes anything is denied. Turn it on together with taking `NO_PURGE` out of the zone's `D()` line: with `NO_PURGE`
left in, nothing is deleted whatever the stack says; with `NO_PURGE` out and `prune` off, a plan that deletes is denied by the delete rule and the config is
denied by the lint's `keep-unknown` rule (below).

While `NO_PURGE` is on, DNSControl notes in its report the records it keeps. The summary does not count that note as a change.

## Lint

DNSControl's own `check` accepts configs that are wrong in ways that hurt, so the platform adds a small lint over the evaluated config
(`dnscontrol print-ir`). It runs in the plan's summary job as `orch dns lint`, adds its counts and findings to the summary, and never carries a
value. An `error` denies the apply, a `warn` is shown on the merge request and nothing more.

| Rule | Severity | Finds |
|---|---|---|
| `spf-single` | error | A name with more than one SPF record (`v=spf1`), which receivers treat as no SPF at all. |
| `keep-unknown` | error | A zone that deletes the records it does not list while the stack's `dns.prune` is off. |
| `dmarc-with-mx` | warn | A name with a mail server (`MX`) and no DMARC record of its own or at the apex. |
| `caa-apex` | warn | A zone with no `CAA` record at the apex. |
| `ttl-range` | warn | A TTL under 60 or over 86400 seconds. |

`orch dns lint [--prune]` reads `dnscontrol print-ir` on standard input and prints the report as one JSON document, whatever it finds (the exit
code says only whether the input could be read):

```sh
dnscontrol print-ir | orch dns lint
dnscontrol print-ir | orch dns lint --prune
```

`--prune` is the stack's `dns.prune`. The summary job runs it for you, so it needs the helper image to have an `orch` that knows the command; if it
does not, or the plan job is from before the lint, the summary carries no lint and the merge request note shows none. **The lint fails open, the
claims and the delete rule do not.** The lint reads DNSControl 5's records; on an older version the SPF, DMARC and MX rules see none.

## Drift

A zone with a `drift_every` in `stack.yml` is planned on that schedule, on the default branch. An empty plan is in sync; any change is drift,
reported once for as long as it lasts, and again when it has been put right and comes back. The drift plan never applies.

## Token scoping

The token is the boundary. Give each zone stack its own, scoped to that zone and to nothing the stack does not need, and keep it only in the
stack's environment. Rotate it with the platform's rotation like any secret variable ([rotation.md](rotation.md)).

- **Cloudflare.** DNSControl's page for the provider lists the token permissions it needs: `Zone → Zone → Read` and `Zone → DNS → Edit` for records,
  and `Zone → SSL and Certificates → Edit` (the page lists it among those it always needs). Anything else it lists (Page Rules, redirects, Workers) is
  only for configs that use them. Its `creds.json` fields are `TYPE`, `apitoken` and `accountid`; the scaffold writes `apitoken`, so add `accountid` if DNSControl asks for it. DNSControl's page does not say how to restrict a token to
  zones; that is Cloudflare's own setting on the token (its zone resources: include the specific zones).
- **Route 53.** DNSControl's example policy lists `route53:GetHostedZone`, `route53:ListHostedZones`, `route53:ListResourceRecordSets`,
  `route53:ChangeResourceRecordSets`, `route53:UpdateHostedZoneComment` and `route53:CreateHostedZone`, all on `"Resource": "*"`. Its page does not
  discuss narrowing it. AWS's own IAM documentation allows the record actions to be limited to a hosted zone
  (`arn:aws:route53:::hostedzone/<ID>`), while listing and creating hosted zones cannot be. Leave `CreateHostedZone` out: a zone should exist before
  a stack manages it. Its `creds.json` fields include `KeyId` and `SecretKey`; it also takes `Token`, `Region`, `Profile`, `RoleArn` and others.

**Not verified here:** neither token setup was run against a real account. The permission lists above are what the two documentation pages say
on the day this was written (2026-10-20), and the narrowing is each provider's own feature. The first real `push` to a real zone is the check:
do it on a throwaway zone with a zone-scoped token before pointing a stack at a production one.

## Next to external-dns

[external-dns](https://github.com/kubernetes-sigs/external-dns) keeps the records of a Kubernetes cluster. This feature does not replace it and
does not try to read what it owns. Never let both manage one name: either delegate a subdomain to the cluster's own zone, or keep `NO_PURGE` on
(the default here), which leaves the records external-dns made alone. Do not turn `prune` on for a zone external-dns also writes to without
telling DNSControl to ignore those names.

## What this deliberately does not do

- The platform does not call a DNS provider or registrar, so there is no record editor in the UI and no instant plan; records live in the repository.
- No other engine (octoDNS), no registrar or NS delegation, no DNSSEC keys.
- No propagation checks after an apply.
- A zone is not costed, and a policy set (`tags` on a stack) cannot judge one: a zone that carries a set's tag is refused rather than left unjudged.
- Two pipelines pushing one zone together are kept apart by the stack's `resource_group`; the same zone in two stacks is refused by the claim.

## Testing it

The generated jobs are tested against a fake `dnscontrol` and against recorded output of the real one. Two opt-in runs use a real DNSControl
binary and its local `BIND` provider (no network, no account):

```sh
DNSCONTROL_BIN=/path/to/dnscontrol bun test packages/iac/src/pipeline-gen.dns.test.ts
ORCH_E2E_DNSCONTROL=1 DNSCONTROL_BIN=/path/to/dnscontrol bun test packages/iac/src/dns.e2e.test.ts
```

The first checks the import job and the lint's input; the second runs the plan and apply scripts end to end: add a record, plan, apply, plan again
(empty), and an apply whose changes are not the planned ones, which pushes nothing. It needs `sh`, `jq` and `curl`; `wget` is used when there is one.
