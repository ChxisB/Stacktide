# Secret scanning (SCAN-1 to SCAN-7)

GitLab's **secret detection** job looks for credentials committed to a repository. The platform does not scan anything
itself. It reads the report that job leaves behind, keeps **where** each leaked secret was seen, and lets people triage it.

> **A finding is a secret that was in your repository, and it must be revoked at the source.** Dismissing a finding in the
> platform only stops it being counted. It does not make the secret safe, and the platform cannot revoke it: it holds no cloud
> credentials. Whoever owns the credential (the cloud account, the token's issuer) has to revoke or rotate it, because the
> value stays in the repository's history after the file is fixed.

## Switching the scan on

The starter templates (`bun-app`, `node-app`, `docker-image`) have one switch for it, `secretDetection`, which is off unless
you set it. It is the platform's own parameter, the same for every template, so a template cannot declare it.

```
orch pipeline setup bun-app --param-json secretDetection=true
```

With it on, the generated `.gitlab-ci.yml` includes **GitLab's own** template (`Jobs/Secret-Detection.gitlab-ci.yml`, none of
it copied into your repository) and adds a `secret_detection` job that:

- runs in the pipeline's **first stage** when the pipeline has no `test` stage (GitLab's job is in `test`, and a stage the
  pipeline does not declare is a lint error), and in `test` when it has one;
- takes nothing from `default`, which holds the starter's image, services and install step, none of it meant for the analyzer.

Switching it on is the usual pipeline update: one merge request, the lint verdict shown first. Switching it off takes both out
again. It works in the include and component modes too: the thin file gets the include and the job, and the template's own
`inputs` are untouched.

**The project's runners.** The analyzer runs in a container, so it needs a runner with the `docker`, `docker+machine`,
`docker-autoscaler` or `kubernetes` executor. `GET …/pipeline` answers with `warnings` for a project that has the switch on and
whose runners cannot be shown to do that. A **warning, never a failure**: the platform can list a project's runners (see
[worker pools](worker-pools.md)) but GitLab's API does not say which executor a runner has, so the warning always says the
runners are not known, and it does not stop an apply.

An `include` of your own in an override replaces the template's (overrides replace lists), which would take GitLab's template
out and leave the job without a script: GitLab's lint says so in the preview.

## The gate (SCAN-6)

Off by default. An organization can make open findings count against its applies:

| `GET` / `PUT /organizations/:orgId/secret-gate` `{"gate": "off" \| "warn" \| "deny"}` | Who |
|---|---|
| read | anyone in the organization |
| set | an organization admin (audited as `secret.gate.update`, with the previous value) |

| Gate | An open finding on the default branch… |
|---|---|
| `off` | is not looked at |
| `warn` | adds a `Secrets:` line to the merge request note, naming the count and the rule `secret-findings-open` |
| `deny` | refuses the apply with `409 secret_findings_open` (the same refusal on the merge path), and starts nothing |

What counts is a finding that is **open** and was **seen on the project's default branch**. Dismissed and resolved findings,
findings seen only on other branches, and other projects' findings do not. Dismissing a finding (after revoking the secret at
its source) frees the apply. The setting is the organization's, not the repository's, so a merge request cannot lower it.

Limits: the apply reads the gate and the count **when it runs**, but the merge request note shows them as of its **last
update** (a plan event), so a finding that arrives later is in the apply's answer before it is in the note. The count and the
claim of the stacks are not one transaction, so a finding stored in those few milliseconds does not hold that apply. There is no
screen or command for the setting yet: it is the API.

## What is kept

For each finding: the project, the **rule** that matched (for example `aws-access-token`), the **path** and **line**, the
**commit**, the **severity**, the **ref** it was seen on, the scanner's **fingerprint** for it, and when it was first and last
seen. That is all. The secret itself, the matched text, the scanner's description and extract, and the commit's message and
author are never read into a row, a response, an audit event, a log line or a merge request note, and the table has no column
that could hold them (a test pins its column list).

## Where findings come from

When a pipeline of a linked project finishes (success or failure: the job failing is not the scan's verdict), the platform
lists its jobs. If one is named `secret_detection` it downloads that job's `gl-secret-detection-report.json` artifact through
the project's GitLab connection.

- A report over 5 MB, one that is not JSON of the expected shape, or one with more than 1000 findings is **dropped, with the
  reason in the log and no text of it**, and is not retried.
- No such job, a job that did not run, or no artifact is not an error: there is nothing to read.
- GitLab refusing the connection's token drops the event; GitLab failing is retried.

## What a report does to findings

Findings are unique per project and fingerprint.

| The report… | The finding… |
|---|---|
| has it, and it is new | is stored `open` |
| has it again | keeps `first_seen_at`, moves `last_seen_at`; stays `open` or `dismissed` |
| has it, and it was `resolved` | is `open` again when the **default branch's** scan reports it (the secret is back); a scan of any other branch leaves it alone |
| lacks it, for a scan of the **default branch** that finished and looked at everything | `open` → `resolved` |
| lacks it, for any other branch, or a partial or failed scan, or a report with an entry that could not be read | is left as it was |

A **dismissed** finding is a person's call and no scan undoes it. A finding seen on another branch is stored with that branch's
name and is **never resolved automatically**: only the default branch's scan can say a finding is gone. Once a finding has
been seen on the default branch it stays a default-branch finding.

## Triage

| | Who | Does |
|---|---|---|
| `GET /organizations/:orgId/projects/:projectId/findings` | any member of the project | Lists findings, oldest first, by cursor; `?status=open\|dismissed\|resolved` filters |
| `GET …/findings/:findingId` | any member | One finding |
| `POST …/findings/:findingId/dismiss` `{"reason": "…"}` | project maintainer (or an organization admin) | Open → dismissed. The reason is required (1 to 1000 characters; a missing, empty or blank one is `422`), and the row records who and when |
| `POST …/findings/:findingId/reopen` | project maintainer | Dismissed → open, clearing the reason, person and time |

Only an `open` finding can be dismissed and only a `dismissed` one reopened; anything else is `409 finding_not_open` or
`finding_not_dismissed` and changes nothing. Both calls write an audit event (`finding.dismiss`, `finding.reopen`) with the
rule and path. Reopening clears the row's reason, so **the audit event of the dismissal is where the reason is kept**.

### From the command line and the screen (SCAN-7)

```
orch findings ls [--status open|dismissed|resolved]
orch findings dismiss <ID> --reason "revoked in the cloud account"
orch findings reopen <ID>
```

Each takes `--org` and `--project` (or the project file's), and `--json` for scripts. `ls` prints one line per finding (id,
status, severity, rule, `path:line`, branch, and for a dismissed one who and why) and, when an open one is listed, a reminder on
stderr to revoke it at the source. `dismiss` needs a non-blank `--reason` and is refused before any request without one.

The **Findings** page in the navigation lists the chosen project's findings (Open, Dismissed, Resolved or All), with the same
notice above the list. Dismissing asks for a reason; a dismissed finding shows who dismissed it, when and why, and has a
**Reopen** button. The page shows the buttons to every member: a reporter who presses one is told by the API that it is not
theirs to press, and nothing changes.

## Limits worth knowing

- The report is read when its pipeline finishes. Two pipelines finishing out of order can leave the older report's view of the
  project for a while; the next scan corrects it.
- The scan runs in **your** pipeline. A project whose CI does not include the secret-detection job has no findings, and the
  platform does not say so.
- The fingerprint is taken as the scanner gives it. If a GitLab release changes how it makes fingerprints, existing findings
  resolve on the next default-branch scan, and the same secrets appear as new findings, with any dismissal lost.
- **The report is as trustworthy as the project's own CI.** It comes from a job in the project's pipeline, so someone who can
  change that pipeline can leave findings out of the report (a clean report on the default branch resolves them) and so lift a
  `deny` gate. The gate stops a careless apply, not a person with control of the project's CI. Which pipelines count is
  decided by the pipeline's `ref` name, and a tag pipeline is not told apart from a branch's: a tag named like the default
  branch would be read as that branch (GitLab's own tag protection is the guard).
- A finding is matched to the default branch by the project's `default_branch` **as the platform holds it**. The name
  is the one the project was added with, and nothing refreshes it: after the default branch is renamed in GitLab, a scan of
  the new name is read as another branch, so its findings are not counted by the gate and nothing is resolved.
- A finding seen only on a merge request's or other branch's pipeline is never resolved by the platform (only the default
  branch's scan can say it is gone), so it stays open until the default branch reports on it, or someone dismisses it.
- A rule is kept only when it is a lower-case name of letters, digits and hyphens, as gitleaks gives it. Any other
  identifier reads as `unknown`. That is deliberate: rewriting an odd value into a rule name could carry part of a secret into
  a row.
- A finding with a line that is not a positive whole number below 2,147,483,648 is kept with no line.
- GitLab may answer an artifact download with a redirect to object storage. The platform does not follow it (it would send
  the connection's token to another host), so a pipeline whose report is served that way is not read and is retried until it
  is dropped. This is written from GitLab's documentation, not seen against a real instance.
