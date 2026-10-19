# 15 Component Mode and Template Registry - Tasks

### CMP-1 - Component file layout and catalog validator  `[x]` M - deps: PIPE-9
Do: in `packages/pipelines`: `componentPath`, `componentFile` (reusing `includeFile`), and `validateCatalogLayout(files)` checking `templates/` entries, `spec:inputs` header, README, description, 100-component cap.
Done when: tests accept a valid layout and reject each missing piece; a component file equals the include file body under the same parameters (snapshot).

### CMP-2 - Component render mode through apply/MR  `[x]` M - deps: CMP-1, PIPE-6
Do: `renderComponent(template, layers, {project, name, version})`; additive migration allows `mode = 'component'`; accept tags, partial semver and SHAs only (refuse `~latest`, branches); lint on the mock; switching modes yields a clean MR; audit row names project and version. **`/security-review`.**
Done when: renders and lints in all three modes; inline <-> include <-> component switches each give a clean MR; a branch or `~latest` ref is 422; canary test as in PIPE-9.

### CMP-3 - `templates:component` command  `[x]` S - deps: CMP-1
Do: write a catalog-ready templates project to a directory: `templates/*.yml`, `README.md`, `.gitlab-ci.yml` with the tag release job. The platform writes nothing to GitLab.
Done when: the output passes `validateCatalogLayout` in a test; a second run changes nothing byte for byte; paths cannot leave the directory.

### CMP-4 - Registry read model and endpoint  `[x]` M - deps: CMP-1, GL-5
Do: `packages/gitlab` methods for the `templates/` tree and tags (mock + contract); `GET /organizations/:o/template-registry?project=` returning name, versions, inputs (parsed from `spec:inputs`, size-capped).
Done when: fixture templates project lists correctly on the mock; a malformed component file is reported, not a 500; org admin guard; spec/authz tests green.

### CMP-5 - Consumers and outdated view  `[x]` S - deps: CMP-4, PIPE-7
Do: for a templates project, list pipeline configs that include it and whether a newer tag exists; bumping reuses the fleet upgrade, nothing new writes to GitLab.
Done when: tests for up-to-date, behind, unpublished and unknown-project cases.

### CMP-6 - CLI and UI  `[x]` M - deps: CMP-4, UI-6, CLI-6
Do: `orch pipeline` mode flag (`--mode component --version`), registry list in `orch template ls`; the setup wizard gains a mode selector and a version picker from the registry.
Done when: CLI command tests; component tests for the selector and the empty-registry state; journey test still green.
