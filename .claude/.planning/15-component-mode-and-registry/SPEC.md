# 15 Component Mode and Template Registry - Spec
Prefix: CMP · Milestone: M5 · Status: todo (planned 2026-10-19, awaiting approval)

## Goal
Offer GitLab CI/CD *component* render mode next to inline and `include:` mode, and make the templates project publishable to the GitLab CI/CD Catalog - the "registry" - with a read view of what it publishes and who uses which version.

## Scope
`component:` rendering through the existing apply/MR flow; component file layout and a catalog-layout validator; a command that writes a catalog-ready templates project; a registry read model; an outdated-consumers view.

## Non-goals
Hosting our own public registry service (GitLab's Catalog is the registry; hosting one is infra and an open question below). The platform writing to the templates project (still a person's commit, as in PIPE-9). Cross-instance components (GitLab requires the same instance).

## Design
- **Already built:** PIPE-9 include mode (`include:` + inputs against a templates project, eject by re-applying inline). Component mode is the same flow with a different include form, so it is a new `mode` value, not a new pipeline.
- **GitLab syntax** (docs read 2026-10-19): `include: - component: $CI_SERVER_FQDN/<group>/<project>/<name>@<version>` with `inputs:`; the component file has a `spec: inputs:` header, `---`, then jobs, with `$[[ inputs.x ]]`; files live in `templates/<name>.yml` or `templates/<name>/template.yml`; max 100 per project. `@<version>` is a SHA, tag, branch, `~latest` or partial semver (catalog only).
- **Reuse:** PIPE-9's `includeFile` already emits `spec:inputs` + `$[[ inputs ]]`; the component file is the same text at a different path. Only the path, the `component:` line and the catalog extras (README, release job) are new.
- **Pinning:** the platform renders only tags, partial semver or SHAs - not `~latest` or branches. A moving ref means a merged pipeline can change without an MR, which is the trust PIPE-9 already flags.
- **Catalog publishing needs** (docs): catalog toggle in project settings (owner), a description, a `README.md`, at least one component, and a release job on a semver tag. Settings and tags are a person's action; the command writes the files, the validator checks them offline.
- **Registry read model:** read the templates project through `packages/gitlab` (tree of `templates/`, tags, each file's `spec:inputs`), return name, versions, inputs. Consumers = pipeline configs whose `include_project` matches; "outdated" = a newer tag exists. A bump is the existing fleet upgrade (PIPE-7).

## Acceptance
A project can be switched inline -> include -> component -> inline, each switch a clean MR; the generated templates project passes the catalog-layout validator and each template lints on the mock; the registry endpoint lists templates, versions and inputs of a fixture project and flags consumers behind the latest tag.

## Risks / human gates
- First real publish to the Catalog (toggle, tag, release job) and first real component MR are human gates, as in PIPE-9; GitLab's component semantics are unverified end to end (mock only).
- `/security-review` on CMP-2 (a pipeline now runs another project's code at a ref the maintainer of that project moves).

## Open questions
1. Is "public" registry just the GitLab.com Catalog for you, or do you want the platform to host a browsable registry for other organizations? (Plan assumes the former.)
2. Allow `@~latest` as an explicit opt-in per pipeline, or never?
