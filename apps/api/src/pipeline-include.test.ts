import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createOrganization,
  createProject,
  getPipelineConfig,
  savePipelineConfig,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import {
  componentFile,
  componentPath,
  includeFile,
  includePath,
  loadTemplates,
  render,
  renderComponent,
  renderInclude,
  type Template,
} from "@orch/pipelines";
import {
  applyPipeline,
  PIPELINE_BRANCH,
  PIPELINE_FILE,
  type PipelineDeps,
  type PipelineMode,
  type PipelineRequest,
  previewPipeline,
} from "./pipeline-apply";
import { type FleetDeps, upgradeFleet } from "./pipeline-fleet";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TEMPLATES = "fx/templates";

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
const v1 = await loadTemplates();
const bun = v1.find((c) => c.manifest.name === "bun-app") as Template;
/** bun-app at 1.1.0, with a job more. */
const bunNext: Template = {
  manifest: { ...bun.manifest, version: "1.1.0" },
  pipeline: `${bun.pipeline}\nsecurity:\n  stage: check\n  script:\n    - echo scan\n`,
};
const v2 = [...v1, bunNext];
beforeAll(async () => {
  t = await createTestDb();
});
afterEach(() => mock?.stop());
afterAll(async () => {
  await t.drop();
});

let n = 0;
/**
 * An organization, a connection, a project linked to a mock GitLab project and a templates project
 * that holds the include files of `published`.
 */
async function world(published: readonly Template[] = v1) {
  mock?.stop();
  mock = createMockGitlab({ scopes: ["api"] });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  mock.addProject({
    path: TEMPLATES,
    files: Object.fromEntries(published.map((p) => [includePath(p.manifest), includeFile(p)])),
  });
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  const make = async (files?: Record<string, string>) => {
    const remote = mock.addProject({ path: `fx/p${++n}`, files });
    const project = await createProject(t.db, {
      organizationId: org.id,
      name: `p${n}`,
      gitlabProjectId: remote.id,
    });
    return { remote, project };
  };
  const { remote, project } = await make();
  const deps: PipelineDeps = { db: t.db, catalog: v1, gitlab: async () => api };
  const run = async (request: PipelineRequest, on = project) => {
    const applied = await applyPipeline(deps, org.id, on.id, connection.id, request);
    await savePipelineConfig(t.db, applied.config); // what the route's transaction does
    return applied;
  };
  const file = (ref: string, on = remote) =>
    api.repository.getFile(on.id, PIPELINE_FILE, ref).then(
      (f) => f.content,
      () => null,
    );
  const commits = (on = remote) =>
    mock.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.includes(`/projects/${on.id}/`) &&
        r.path.endsWith("/repository/commits"),
    ).length;
  const mrs = async (on = remote) => {
    const out = [];
    for await (const m of api.mergeRequests.list(on.id)) out.push(m);
    return out;
  };
  const config = (on = project) => getPipelineConfig(t.db, org.id, on.id);
  return { org, connection, project, remote, api, deps, make, run, file, commits, mrs, config };
}

const into = { project: TEMPLATES, ref: "main" };
const thin: PipelineRequest = { template: "bun-app", mode: "include", include: into };
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error("did not throw");
};

describe("the include mode", () => {
  test("a preview shows the thin file, lints it through the templates project and writes nothing", async () => {
    const w = await world();
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, thin);
    expect(p.mode).toBe("include");
    expect(p.text).toBe(renderInclude(bun, [{}], into));
    expect(p.text).toContain(`file: ${includePath(bun.manifest)}`);
    expect(p.validation.lint).toMatchObject({ valid: true, errors: [] });
    expect(w.commits()).toBe(0);
    expect(await w.config()).toBeUndefined();
  });

  test("an apply commits the thin file to the branch and opens one merge request that says where the pipeline lives", async () => {
    const w = await world();
    const r = await w.run({ ...thin, params: { bunVersion: "1.2" } });

    expect(r).toMatchObject({
      outcome: "opened",
      committed: true,
      existing: "none",
      mode: "include",
    });
    const text = renderInclude(bun, [{ params: { bunVersion: "1.2" } }], into);
    expect(await w.file(PIPELINE_BRANCH)).toBe(text);
    expect(await w.file("main")).toBeNull(); // nothing landed on the default branch
    const [mr, ...more] = await w.mrs();
    expect(more).toHaveLength(0);
    expect(mr?.description).toContain(
      `\`${includePath(bun.manifest)}\` of \`${TEMPLATES}\` at \`main\``,
    );
    expect(mr?.description).toContain("must be published there before this is merged");
    expect(mr?.description).toContain(
      `Whoever can change \`${TEMPLATES}\` changes this project's pipeline.`,
    );
    expect(r.config).toMatchObject({
      mode: "include",
      includeProject: TEMPLATES,
      includeRef: "main",
    });
    expect(await w.config()).toMatchObject({
      mode: "include",
      includeProject: TEMPLATES,
      includeRef: "main",
    });
  });

  test("without a ref the default branch of the templates project is used", async () => {
    const w = await world();
    const r = await w.run({ ...thin, include: { project: TEMPLATES } });
    expect(r.config).toMatchObject({
      mode: "include",
      includeProject: TEMPLATES,
      includeRef: null,
    });
    expect(await w.file(PIPELINE_BRANCH)).not.toContain("ref:");
    expect((await w.mrs())[0]?.description).not.toContain(" at `");
  });

  test("a template that is not published there is refused by GitLab's lint and nothing is committed", async () => {
    const w = await world([]);
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, thin);
    expect(p.validation.lint.valid).toBe(false);
    expect(p.validation.lint.errors).toEqual([
      `Project \`${TEMPLATES}\` file \`/${includePath(bun.manifest)}\` does not exist!`,
    ]);
    const e = await failure(w.run(thin));
    expect(e).toMatchObject({ code: "pipeline_invalid", status: 422 });
    expect(e.message).toContain("does not exist");
    expect(w.commits()).toBe(0);
    expect(await w.mrs()).toHaveLength(0);
    expect(await w.config()).toBeUndefined();
  });

  test("a templates project GitLab does not know is refused the same way", async () => {
    const w = await world();
    const e = await failure(w.run({ ...thin, include: { project: "fx/nowhere" } }));
    expect(e).toMatchObject({ code: "pipeline_invalid", status: 422 });
    expect(e.message).toContain("not found or access denied");
    expect(w.commits()).toBe(0);
  });

  test("running it again with the same inputs changes nothing; other parameters edit the same merge request", async () => {
    const w = await world();
    const first = await w.run(thin);
    const commits = w.commits();
    expect(await w.run(thin)).toMatchObject({
      outcome: "unchanged",
      committed: false,
      mr: first.mr,
    });
    expect(w.commits()).toBe(commits);

    const again = await w.run({ ...thin, params: { testScript: "ci:test" } });
    expect(again).toMatchObject({ outcome: "updated", committed: true, mr: first.mr });
    expect(w.commits()).toBe(commits + 1);
    expect(await w.mrs()).toHaveLength(1);
    expect(await w.file(PIPELINE_BRANCH)).toContain("testScript: ci:test");
  });

  test("overrides are merged over the thin file and the pipeline still lints", async () => {
    const w = await world();
    const r = await w.run({ ...thin, overrides: { build: { tags: ["big"] } } });
    expect(r.validation.lint.valid).toBe(true);
    expect(await w.file(PIPELINE_BRANCH)).toContain("build:\n  tags:\n    - big");
  });

  test("the include mode and the templates project go together or not at all", async () => {
    const w = await world();
    expect(await failure(w.run({ template: "bun-app", mode: "include" }))).toMatchObject({
      code: "invalid_pipeline",
      message: "The include mode needs the templates project",
    });
    expect(await failure(w.run({ template: "bun-app", include: into }))).toMatchObject({
      code: "invalid_pipeline",
      message: "A templates project goes with the include and component modes alone",
    });
    expect(
      await failure(w.run({ template: "bun-app", mode: "inline", include: into })),
    ).toMatchObject({ code: "invalid_pipeline" });
    expect(w.commits()).toBe(0);
  });

  test("a templates project that is not a project path, and an override of the include, are refused", async () => {
    const w = await world();
    const bad = await failure(w.run({ ...thin, include: { project: "../x" } }));
    expect(bad).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(bad.message).toContain("include project");
    const over = await failure(w.run({ ...thin, overrides: { include: [] } }));
    expect(over.message).toContain("include is the template's own");
    expect(w.commits()).toBe(0);
  });
});

describe("switching between the modes", () => {
  test("ejecting to inline edits the same branch and merge request, and a project stays in the mode it was last set up in", async () => {
    const w = await world();
    const first = await w.run({ ...thin, params: { bunVersion: "1.2" } });
    const commits = w.commits();

    const ejected = await w.run({ template: "bun-app", params: { bunVersion: "1.2" } });
    expect(ejected).toMatchObject({
      outcome: "updated",
      committed: true,
      mode: "inline",
      mr: first.mr,
    });
    expect(await w.file(PIPELINE_BRANCH)).toBe(render(bun, [{ params: { bunVersion: "1.2" } }]));
    expect(w.commits()).toBe(commits + 1);
    expect(await w.mrs()).toHaveLength(1);
    expect(await w.file("main")).toBeNull();
    expect(await w.config()).toMatchObject({
      mode: "inline",
      includeProject: null,
      includeRef: null,
    });
    expect((await w.mrs())[0]?.description).not.toContain("must be published");

    const back = await w.run({ ...thin, params: { bunVersion: "1.2" } });
    expect(back).toMatchObject({
      outcome: "updated",
      committed: true,
      mode: "include",
      mr: first.mr,
    });
    expect(await w.file(PIPELINE_BRANCH)).toBe(
      renderInclude(bun, [{ params: { bunVersion: "1.2" } }], into),
    );
    expect(await w.config()).toMatchObject({ mode: "include", includeProject: TEMPLATES });
    expect(await w.mrs()).toHaveLength(1);
  });

  test("a thin file that was merged is a generated file: ejecting proposes the inline one and leaves the default branch alone", async () => {
    const w = await world();
    const merged = renderInclude(bun, [{}], into);
    const { remote, project } = await w.make({ [PIPELINE_FILE]: merged });

    const same = await w.run(thin, project);
    expect(same).toMatchObject({
      outcome: "in_place",
      committed: false,
      existing: "identical",
      mr: null,
    });

    const ejected = await w.run({ template: "bun-app" }, project);
    expect(ejected).toMatchObject({ outcome: "opened", committed: true, existing: "generated" });
    expect(await w.file("main", remote)).toBe(merged);
    expect(await w.file(PIPELINE_BRANCH, remote)).toBe(render(bun));
    expect(await w.commits(remote)).toBe(1);
  });
});

const CATALOG = "fx/catalog";
const comp = (ref = "1.0.0", extra: Partial<PipelineRequest> = {}): PipelineRequest => ({
  template: "bun-app",
  mode: "component",
  include: { project: CATALOG, ref },
  ...extra,
});
/** A catalog project that holds the component of each of `published`, tagged 1.0.0 (the mock is the one `world` made). */
const publishCatalog = (published: readonly Template[] = v1) => {
  mock.addProject({
    path: CATALOG,
    files: Object.fromEntries(published.map((p) => [componentPath(p.manifest), componentFile(p)])),
  });
  mock.addTag(CATALOG, "1.0.0");
};
const asked = { project: CATALOG, version: "1.0.0" };

describe("the component mode", () => {
  test("a preview shows the thin file, lints it through the catalog project and writes nothing", async () => {
    const w = await world();
    publishCatalog();
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, comp());
    expect(p.mode).toBe("component");
    expect(p.text).toBe(renderComponent(bun, [{}], asked));
    expect(p.text).toContain(`component: $CI_SERVER_FQDN/${CATALOG}/bun-app@1.0.0`);
    expect(p.validation.lint).toMatchObject({ valid: true, errors: [] });
    expect(w.commits()).toBe(0);
    expect(await w.config()).toBeUndefined();
  });

  test("an apply commits the thin file to the branch and opens one merge request that says where the pipeline lives", async () => {
    const w = await world();
    publishCatalog();
    const r = await w.run(comp("1.0.0", { params: { bunVersion: "1.2" } }));
    expect(r).toMatchObject({ outcome: "opened", committed: true, existing: "none" });
    expect(r.mode).toBe("component");
    expect(await w.file(PIPELINE_BRANCH)).toBe(
      renderComponent(bun, [{ params: { bunVersion: "1.2" } }], asked),
    );
    expect(await w.file("main")).toBeNull();
    const [mr, ...more] = await w.mrs();
    expect(more).toHaveLength(0);
    expect(mr?.description).toContain(`the component \`bun-app\` of \`${CATALOG}\` at \`1.0.0\``);
    expect(mr?.description).toContain("must be published in that version before this is merged");
    expect(mr?.description).toContain(
      `Whoever can release \`${CATALOG}\` changes this project's pipeline.`,
    );
    expect(mr?.description).not.toContain("without a merge request");
    expect(r.config).toMatchObject({
      mode: "component",
      includeProject: CATALOG,
      includeRef: "1.0.0",
    });
    expect(await w.config()).toMatchObject({
      mode: "component",
      includeProject: CATALOG,
      includeRef: "1.0.0",
    });
  });

  test("a partial release or a SHA is accepted; the merge request warns that a partial release moves", async () => {
    const w = await world();
    publishCatalog();
    const sha = mock.tagSha(CATALOG, "1.0.0");
    for (const ref of ["1", "1.0", sha]) {
      expect(
        (await previewPipeline(w.deps, w.org.id, w.project.id, comp(ref))).validation.lint.valid,
      ).toBe(true);
    }
    await w.run(comp("1"));
    expect((await w.mrs())[0]?.description).toContain(
      "`1` follows the newest matching release, so it can change without a merge request here",
    );
    await w.run(comp(sha));
    expect((await w.mrs())[0]?.description).not.toContain("without a merge request");
  });

  test("a branch, ~latest, a missing version or a project that is not a path is refused and nothing is committed", async () => {
    const w = await world();
    publishCatalog();
    for (const ref of ["main", "~latest", "v1.0.0", "1.0.0-rc.1"]) {
      const e = await failure(w.run(comp(ref)));
      expect(e).toMatchObject({ code: "invalid_pipeline", status: 422 });
      expect(e.message).toContain("component version");
    }
    const none = await failure(
      w.run({ template: "bun-app", mode: "component", include: { project: CATALOG } }),
    );
    expect(none).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(none.message).toContain("component version");
    const bad = await failure(w.run({ ...comp(), include: { project: "../x", ref: "1.0.0" } }));
    expect(bad.message).toContain("include project");
    const over = await failure(w.run(comp("1.0.0", { overrides: { include: [] } })));
    expect(over.message).toContain("include is the template's own in component mode");
    expect(w.commits()).toBe(0);
    expect(await w.config()).toBeUndefined();
  });

  test("a version or a component that is not published is refused by GitLab's lint and nothing is committed", async () => {
    const w = await world();
    publishCatalog();
    const gone = await failure(w.run(comp("2.0.0")));
    expect(gone).toMatchObject({ code: "pipeline_invalid", status: 422 });
    expect(gone.message).toContain("reference '2.0.0' does not exist");
    const nowhere = await failure(
      w.run({ ...comp(), include: { project: "fx/nowhere", ref: "1.0.0" } }),
    );
    expect(nowhere.message).toContain("not found or access denied");
    expect(w.commits()).toBe(0);
    expect(await w.mrs()).toHaveLength(0);

    const empty = await world();
    publishCatalog([]);
    const missing = await failure(empty.run(comp()));
    expect(missing).toMatchObject({ code: "pipeline_invalid" });
    expect(missing.message).toContain(`Component '${CATALOG}/bun-app' does not exist at '1.0.0'`);
    expect(empty.commits()).toBe(0);
  });

  test("the mode and the catalog project go together or not at all", async () => {
    const w = await world();
    expect(await failure(w.run({ template: "bun-app", mode: "component" }))).toMatchObject({
      code: "invalid_pipeline",
      message: "The component mode needs the templates project",
    });
    expect(w.commits()).toBe(0);
  });

  test("running it again with the same inputs changes nothing; another version edits the same merge request", async () => {
    const w = await world();
    publishCatalog();
    mock.addTag(CATALOG, "1.1.0");
    const first = await w.run(comp());
    const commits = w.commits();
    expect(await w.run(comp())).toMatchObject({
      outcome: "unchanged",
      committed: false,
      mr: first.mr,
    });
    expect(w.commits()).toBe(commits);
    expect(await w.run(comp("1.1.0"))).toMatchObject({
      outcome: "updated",
      committed: true,
      mr: first.mr,
    });
    expect(await w.file(PIPELINE_BRANCH)).toContain("bun-app@1.1.0");
    expect(await w.mrs()).toHaveLength(1);
  });
});

describe("switching between inline, include and component", () => {
  test("each switch edits the same branch and merge request, and the project keeps the mode it was last set up in", async () => {
    const w = await world();
    publishCatalog();
    const first = await w.run({ template: "bun-app" });
    const order: [PipelineMode, PipelineRequest, string][] = [
      ["include", thin, renderInclude(bun, [{}], into)],
      ["component", comp(), renderComponent(bun, [{}], asked)],
      ["inline", { template: "bun-app" }, render(bun)],
      ["component", comp(), renderComponent(bun, [{}], asked)],
      ["include", thin, renderInclude(bun, [{}], into)],
    ];
    for (const [mode, request, text] of order) {
      const done = await w.run(request);
      expect(done).toMatchObject({ outcome: "updated", committed: true, mr: first.mr });
      expect(done.mode).toBe(mode);
      expect(await w.file(PIPELINE_BRANCH)).toBe(text);
      expect((await w.config())?.mode).toBe(mode);
      expect(await w.mrs()).toHaveLength(1);
      expect(await w.file("main")).toBeNull();
    }
    expect(await w.config()).toMatchObject({
      mode: "include",
      includeProject: TEMPLATES,
      includeRef: "main",
    });
    await w.run({ template: "bun-app" });
    expect(await w.config()).toMatchObject({
      mode: "inline",
      includeProject: null,
      includeRef: null,
    });
  });

  test("a thin component file that was merged is a generated file: ejecting proposes the inline one", async () => {
    const w = await world();
    publishCatalog();
    const merged = renderComponent(bun, [{}], asked);
    const { remote, project } = await w.make({ [PIPELINE_FILE]: merged });
    expect(await w.run(comp(), project)).toMatchObject({
      outcome: "in_place",
      existing: "identical",
      mr: null,
    });
    expect(await w.run({ template: "bun-app" }, project)).toMatchObject({
      outcome: "opened",
      existing: "generated",
    });
    expect(await w.file("main", remote)).toBe(merged);
  });
});

describe("a fleet upgrade", () => {
  const fleet = (w: Awaited<ReturnType<typeof world>>): FleetDeps => ({
    db: t.db,
    catalog: v2,
    gitlab: async () => w.api,
    record: async (_projectId, applied) => {
      await savePipelineConfig(t.db, applied.config);
    },
    pause: async () => {},
    logger: createLogger({ level: "error", write: () => {} }),
  });
  /** A project whose default branch already holds the file `request` renders, and that is recorded as set up so. */
  const adopt = async (
    w: Awaited<ReturnType<typeof world>>,
    request: PipelineRequest,
    text: string,
  ) => {
    const on = await w.make({ [PIPELINE_FILE]: text });
    expect(await w.run(request, on.project)).toMatchObject({ outcome: "in_place" });
    return on;
  };
  const merged = renderInclude(bun, [{}], into);
  const body = { template: "bun-app", limit: 10 } as const;

  test("keeps a project in the include mode, pointing at the new version in the same templates project", async () => {
    const w = await world([...v1, bunNext]);
    const on = await adopt(w, thin, merged);

    const plan = await upgradeFleet(fleet(w), w.org.id, body, "plan");
    expect(plan.items).toMatchObject([{ status: "would_upgrade", from: "1.0.0", to: "1.1.0" }]);
    expect(plan.items[0]?.changes).toEqual({ added: 2, removed: 2 }); // the version in the header and in the path

    const done = await upgradeFleet(fleet(w), w.org.id, body, "apply");
    expect(done.items).toMatchObject([{ status: "upgraded", outcome: "opened" }]);
    expect(await w.file(PIPELINE_BRANCH, on.remote)).toBe(renderInclude(bunNext, [{}], into));
    expect(await w.file(PIPELINE_BRANCH, on.remote)).toContain("file: bun-app/1.1.0/pipeline.yml");
    expect(await w.config(on.project)).toMatchObject({
      version: "1.1.0",
      mode: "include",
      includeProject: TEMPLATES,
      includeRef: "main",
    });
  });

  test("blocks a project whose new version is not published in its templates project yet", async () => {
    const w = await world(v1);
    const on = await adopt(w, thin, merged);
    const before = w.commits(on.remote);

    const done = await upgradeFleet(fleet(w), w.org.id, body, "apply");
    expect(done.items).toMatchObject([{ status: "blocked", code: "pipeline_invalid" }]);
    expect(done.items[0]?.message).toContain("bun-app/1.1.0/pipeline.yml");
    expect(await w.config(on.project)).toMatchObject({ version: "1.0.0", mode: "include" });
    expect(await w.file(PIPELINE_BRANCH, on.remote)).toBeNull();
    expect(w.commits(on.remote)).toBe(before);
  });

  test("an inline project in the same fleet stays inline", async () => {
    const w = await world([...v1, bunNext]);
    const thinOne = await adopt(w, thin, merged);
    const inlineOne = await adopt(w, { template: "bun-app" }, render(bun));

    const done = await upgradeFleet(fleet(w), w.org.id, body, "apply");
    expect(done.items.map((i) => i.status)).toEqual(["upgraded", "upgraded"]);
    expect(await w.file(PIPELINE_BRANCH, inlineOne.remote)).toBe(render(bunNext));
    expect(await w.file(PIPELINE_BRANCH, thinOne.remote)).toBe(renderInclude(bunNext, [{}], into));
    expect(await w.config(inlineOne.project)).toMatchObject({
      mode: "inline",
      includeProject: null,
    });
    expect(await w.config(thinOne.project)).toMatchObject({ mode: "include" });
  });

  test("leaves a project in the component mode alone: its version is a release of the catalog project (CMP-5)", async () => {
    const w = await world([...v1, bunNext]);
    publishCatalog();
    const on = await adopt(w, comp(), renderComponent(bun, [{}], asked));
    const before = w.commits(on.remote);
    for (const mode of ["plan", "apply"] as const) {
      const done = await upgradeFleet(fleet(w), w.org.id, body, mode);
      expect(done.items).toMatchObject([
        { status: "skipped", code: "component", from: "1.0.0", to: "1.1.0" },
      ]);
    }
    expect(await w.config(on.project)).toMatchObject({
      version: "1.0.0",
      mode: "component",
      includeRef: "1.0.0",
    });
    expect(w.commits(on.remote)).toBe(before);
    expect(await w.file(PIPELINE_BRANCH, on.remote)).toBeNull();
  });
});
