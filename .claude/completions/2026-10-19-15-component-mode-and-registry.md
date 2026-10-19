# 15 component-mode-and-registry - done 2026-10-19

## What was built
- **CMP-1** Component file layout and catalog validator (`packages/pipelines/src/component.ts`): `templates/<name>.yml` with a `spec: inputs:` header, `---`, then the jobs.
- **CMP-2** A third pipeline delivery mode, `component`, through migration 0033, preview/apply, the three route enums, the MR text and `docs/openapi.json`. Only `1`, `1.2`, `1.2.3` or a 40-hex SHA are accepted as the release; `~latest`, branches, a `v` prefix and prereleases are 422.
- **CMP-3** `bun run templates:component <dir>` writes a publishable catalog project (newest version of each template, a README, a `.gitlab-ci.yml` that releases on a semver tag).
- **CMP-4** `GET /organizations/:orgId/template-registry` (guard `template.registry.read`): releases, components, their inputs, problems per unreadable component.
- **CMP-5** Consumers and standing (`up_to_date`, `behind`, `unpinned`, `unpublished`) on the registry response. A bump is a normal apply with the newer release; the fleet upgrade still skips component projects.
- **CMP-6** `orch pipeline --mode component --include-ref <release>`, `orch template ls --catalog <path>`, and a delivery choice with a release picker in the setup wizard.

## Results
`bun run check` green: typecheck, lint, API 4204 pass + 2 skip + 0 fail (CLI tests run inside it), web 246 pass. `/security-review` on CMP-2: no finding. `/code-review` on the feature: two defects fixed (a YAML alias crashed the registry read; the wizard's release list went stale when the project was edited), the rest in LOG.md. New dependencies: none. Migration 0033 is additive (the mode CHECK widens).

## Invariants
Authz: one new guard (`template.registry.read`, org admin), no new mutation (the registry and consumers are reads; component apply reuses the audited pipeline apply). GitLab traffic only through `packages/gitlab` (`repository.tags` added). No secrets involved; the connection token never reaches a response or log (tested). Tests use the mock GitLab only.

## Not verified / human gates
- Component semantics and error texts are the mock's, from GitLab's docs. First real Catalog publish and first real component MR are human gates (with CLI-7).
- The release job uses `release-cli:latest`, unpinned.
- Registry reads the newest 20 releases (`truncated` says so); consumers are capped at 1000 with no cursor.
- No bulk "bump everything that is behind"; each bump is one apply.
- Tags count as releases; GitLab resolves `~latest` and partial pins against Release objects, so a tag whose release job failed would be offered. Unchecked against a real instance.
- Consumers match the catalog project case-sensitively and the 1000 cap gives no signal.
