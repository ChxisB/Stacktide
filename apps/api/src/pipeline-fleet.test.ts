import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSyncTarget,
  getPipelineConfig,
  type NewPipelineConfig,
  savePipelineConfig,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { gitlabForge } from "@orch/forge";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render, type Template } from "@orch/pipelines";
import { applyPipeline, PIPELINE_BRANCH, PIPELINE_FILE } from "./pipeline-apply";
import {
  FLEET_PAUSE_MS,
  type FleetDeps,
  type FleetRequest,
  lineChanges,
  listFleet,
  upgradeFleet,
} from "./pipeline-fleet";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
// not shaped like a token: the logger's scrubber would hide it, and the test is about the code not putting it there
const CANARY = "zz-canary-8c1f-leak";

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
const v1 = await loadTemplates();
const bun = v1.find((c) => c.manifest.name === "bun-app") as Template;
beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
});
afterEach(() => mock.requests.splice(0));
afterAll(async () => {
  mock.stop();
  await t.drop();
});

/** bun-app at 1.1.0, with a job more (so the header is not the only line that changes). */
const SCAN = "\nsecurity:\n  stage: check\n  script:\n    - echo scan\n";
const bunAt = (version: string, tweak: Partial<Template> = {}): Template => ({
  manifest: { ...bun.manifest, version, ...tweak.manifest },
  pipeline: tweak.pipeline ?? bun.pipeline + SCAN,
});
const v2 = [...v1, bunAt("1.1.0")];

const api = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

let n = 0;
/** An organization with a connection and `count` projects, each set up from bun-app 1.0.0 as PIPE-6 does. */
async function world(count: number, params: (i: number) => Record<string, string> = () => ({})) {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const connect = (name: string) =>
    createConnection(t.db, keys, {
      organizationId: org.id,
      type: "gitlab",
      name,
      config: { baseUrl: mock.url },
      token: mock.token,
    });
  const connection = await connect("live");
  const client = api();
  const projects = [];
  for (let i = 0; i < count; i++) {
    const remote = mock.addProject({ path: `fx/f${++n}` });
    const project = await createProject(t.db, {
      organizationId: org.id,
      name: `p${n}`,
      gitlabProjectId: remote.id,
    });
    const applied = await applyPipeline(
      { db: t.db, catalog: v1, forge: async () => gitlabForge(client) },
      org.id,
      project.id,
      connection.id,
      { template: "bun-app", params: params(i) },
    );
    await savePipelineConfig(t.db, applied.config);
    projects.push({ ...project, remote });
  }
  projects.sort((a, b) => a.id.localeCompare(b.id));
  const opened: string[] = [];
  const pauses: number[] = [];
  const logs: string[] = [];
  const recorded: string[] = [];
  const deps: FleetDeps = {
    db: t.db,
    catalog: v2,
    forge: async (connectionId) => {
      opened.push(connectionId);
      return gitlabForge(client);
    },
    record: async (projectId, applied) => {
      recorded.push(projectId);
      await savePipelineConfig(t.db, applied.config);
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
    logger: createLogger({ level: "debug", write: (line) => logs.push(line) }),
  };
  const request = (more: Partial<FleetRequest> = {}): FleetRequest => ({
    template: "bun-app",
    limit: 50,
    ...more,
  });
  const config = (projectId: string) => getPipelineConfig(t.db, org.id, projectId);
  /** Stores a copy of the project's configuration with `patch` on top (a `projectId` in it copies it to that project). */
  const pin = async (projectId: string, patch: Partial<NewPipelineConfig> = {}) => {
    const from = await config(projectId);
    if (!from) throw new Error("no configuration");
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = from;
    await savePipelineConfig(t.db, { ...rest, ...patch });
  };
  const file = (remoteId: number, ref: string) =>
    client.repository.getFile(remoteId, PIPELINE_FILE, ref).then(
      (f) => f.content,
      () => null,
    );
  /** Commits made to the project since `from` was taken. */
  const commits = (remoteId: number) =>
    mock.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.includes(`/projects/${remoteId}/`) &&
        r.path.endsWith("/repository/commits"),
    ).length;
  return {
    org,
    connection,
    connect,
    projects,
    deps,
    opened,
    pauses,
    logs,
    recorded,
    request,
    config,
    pin,
    file,
    commits,
  };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error("did not throw");
};

describe("listFleet", () => {
  test("lists the organization's projects on this template at another version, from the database alone", async () => {
    const w = await world(3);
    const other = await world(1);
    const [a, b, c] = w.projects;
    if (!a || !b || !c) throw new Error("projects");
    // one is already at the target, one uses another template
    await w.pin(a.id, { version: "1.1.0" });
    await w.pin(b.id, { template: "node-app" });
    mock.requests.splice(0);

    const r = await listFleet(w.deps, w.org.id, w.request());
    expect(r).toMatchObject({ template: "bun-app", target: "1.1.0", next: null });
    expect(r.projects.map((p) => p.projectId)).toEqual([c.id]);
    expect(r.projects[0]).toMatchObject({ projectName: c.name, version: "1.0.0" });
    expect(typeof r.projects[0]?.mrIid).toBe("number");
    expect(mock.requests).toEqual([]); // GitLab was not asked
    expect(w.opened).toEqual([]);

    // another organization's projects are not in it, and ours are not in theirs
    const o = await listFleet(other.deps, other.org.id, other.request());
    expect(o.projects.map((p) => p.projectId)).toEqual(other.projects.map((p) => p.id));
  });

  test("pages by project id: a full page names where to continue, the last one does not", async () => {
    const w = await world(5);
    const ids = w.projects.map((p) => p.id);
    const one = await listFleet(w.deps, w.org.id, w.request({ limit: 2 }));
    expect(one.projects.map((p) => p.projectId)).toEqual(ids.slice(0, 2));
    expect(one.next).toBe(ids[1] ?? "");
    const two = await listFleet(w.deps, w.org.id, w.request({ limit: 2, after: one.next ?? "" }));
    expect(two.projects.map((p) => p.projectId)).toEqual(ids.slice(2, 4));
    expect(two.next).toBe(ids[3] ?? "");
    const three = await listFleet(w.deps, w.org.id, w.request({ limit: 2, after: two.next ?? "" }));
    expect(three.projects.map((p) => p.projectId)).toEqual(ids.slice(4));
    expect(three.next).toBeNull();
    // exactly a page's worth left is not "more"
    const exact = await listFleet(w.deps, w.org.id, w.request({ limit: 5 }));
    expect(exact.next).toBeNull();
  });

  test("an explicit version is the target; an unknown template or version is a 422", async () => {
    const w = await world(1);
    expect(await listFleet(w.deps, w.org.id, w.request({ version: "1.0.0" }))).toMatchObject({
      target: "1.0.0",
      projects: [],
    });
    for (const req of [{ template: "nope" }, { version: "9.9.9" }]) {
      const e = await failure(listFleet(w.deps, w.org.id, w.request(req)));
      expect(e).toMatchObject({ code: "unknown_template", status: 422 });
    }
  });
});

describe("upgradeFleet: the dry run", () => {
  test("says what each project would change and writes nothing", async () => {
    const w = await world(3);
    const before = await Promise.all(w.projects.map((p) => w.config(p.id)));
    const branch = await Promise.all(w.projects.map((p) => w.file(p.remote.id, PIPELINE_BRANCH)));
    mock.requests.splice(0);

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    expect(r).toMatchObject({ template: "bun-app", target: "1.1.0", next: null });
    expect(r.items).toHaveLength(3);
    for (const [i, item] of r.items.entries()) {
      expect(item).toMatchObject({
        projectId: w.projects[i]?.id,
        projectName: w.projects[i]?.name,
        from: "1.0.0",
        to: "1.1.0",
        status: "would_upgrade",
        existing: "none",
        outcome: null,
        mr: null,
        code: null,
      });
      // nothing is merged yet, so the default branch has no file: every line is new
      expect(item.changes).toEqual({
        added: render(bunAt("1.1.0")).split("\n").length - 1,
        removed: 0,
      });
    }
    // nothing written: reads, and GitLab's lint (which stores nothing)
    const writes = mock.requests.filter((q) => q.method !== "GET" && !q.path.endsWith("/ci/lint"));
    expect(writes).toEqual([]);
    expect(w.recorded).toEqual([]);
    expect(await Promise.all(w.projects.map((p) => w.config(p.id)))).toEqual(before);
    expect(await Promise.all(w.projects.map((p) => w.file(p.remote.id, PIPELINE_BRANCH)))).toEqual(
      branch,
    );
  });

  test("counts against the file on the default branch: the header changes and the new job comes in", async () => {
    const w = await world(1);
    const remote = mock.addProject({
      path: `fx/merged${++n}`,
      files: { [PIPELINE_FILE]: render(bunAt("1.0.0", { pipeline: bun.pipeline })) },
    });
    const merged = await createProject(t.db, {
      organizationId: w.org.id,
      name: `merged${n}`,
      gitlabProjectId: remote.id,
    });
    const [p] = w.projects;
    if (!p) throw new Error("project");
    await w.pin(p.id, { projectId: merged.id });

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    expect(r.items.find((i) => i.projectId === merged.id)).toMatchObject({
      status: "would_upgrade",
      existing: "generated",
      changes: { added: 5, removed: 1 },
    });
  });

  test("says when the default branch has a file written by hand, which the merge request would replace", async () => {
    const w = await world(1);
    const remote = mock.addProject({
      path: `fx/hand${++n}`,
      files: { [PIPELINE_FILE]: "stages: [x]\nmine:\n  stage: x\n  script: [echo]\n" },
    });
    const hand = await createProject(t.db, {
      organizationId: w.org.id,
      name: `hand${n}`,
      gitlabProjectId: remote.id,
    });
    const [p] = w.projects;
    if (!p) throw new Error("project");
    await w.pin(p.id, { projectId: hand.id });

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    expect(r.items.find((i) => i.projectId === hand.id)).toMatchObject({
      status: "would_upgrade",
      existing: "hand-written",
    });
  });

  test("a project whose default branch already has the new file has no change", async () => {
    const w = await world(1);
    const [p] = w.projects;
    if (!p) throw new Error("project");
    const remote = mock.addProject({
      path: `fx/same${++n}`,
      files: { [PIPELINE_FILE]: render(bunAt("1.1.0")) },
    });
    const same = await createProject(t.db, {
      organizationId: w.org.id,
      name: `same${n}`,
      gitlabProjectId: remote.id,
    });
    await w.pin(p.id, { projectId: same.id, mrIid: null, mrUrl: null });

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    const item = r.items.find((i) => i.projectId === same.id);
    expect(item).toMatchObject({ status: "no_change", changes: { added: 0, removed: 0 } });

    // applying it records the new version and opens nothing (the file is already there)
    const done = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(done.items.find((i) => i.projectId === same.id)).toMatchObject({
      status: "upgraded",
      outcome: "in_place",
      mr: null,
    });
    expect((await w.config(same.id))?.version).toBe("1.1.0");
  });

  test("a new version GitLab's lint refuses is blocked for everyone, with nothing written", async () => {
    const w = await world(2);
    const broken = [
      ...v1,
      bunAt("1.1.0", { pipeline: `${bun.pipeline}\nbroken:\n  stage: check\n` }),
    ];
    mock.requests.splice(0);
    const r = await upgradeFleet({ ...w.deps, catalog: broken }, w.org.id, w.request(), "plan");
    expect(r.items.map((i) => [i.status, i.code])).toEqual([
      ["blocked", "pipeline_invalid"],
      ["blocked", "pipeline_invalid"],
    ]);
    expect(r.items[0]?.message).toContain("lint refuses");
    const writes = mock.requests.filter((q) => q.method !== "GET" && !q.path.endsWith("/ci/lint"));
    expect(writes).toEqual([]);
  });
});

describe("upgradeFleet: the guardrails (POL-4)", () => {
  /** The project gets an environment `prod`, which a target that does not protect its variables syncs to production. */
  const exposeProduction = async (
    w: Awaited<ReturnType<typeof world>>,
    project: { id: string },
  ) => {
    await createEnvironment(t.db, {
      organizationId: w.org.id,
      projectId: project.id,
      name: "prod",
      slug: "prod",
    });
    await createSyncTarget(t.db, {
      organizationId: w.org.id,
      projectId: project.id,
      name: "main",
      type: "gitlab-variables",
      connectionId: w.connection.id,
      config: { project: "fx/p" },
      environmentMapping: { prod: "production" },
    });
  };

  test("a project that breaks one is blocked in the plan and in the apply, with nothing written; the others go on", async () => {
    const w = await world(2);
    const [open, fine] = w.projects;
    if (!open || !fine) throw new Error("projects");
    await exposeProduction(w, open);

    const plan = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    expect(plan.items.map((i) => [i.projectId, i.status, i.code])).toEqual([
      [open.id, "blocked", "guardrail_violation"],
      [fine.id, "would_upgrade", null],
    ]);
    expect(plan.items.find((i) => i.projectId === open.id)?.message).toContain(
      "production-variable-protected",
    );

    mock.requests.splice(0);
    const done = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(done.items.map((i) => [i.projectId, i.status, i.code])).toEqual([
      [open.id, "blocked", "guardrail_violation"],
      [fine.id, "upgraded", null],
    ]);
    expect(w.commits(open.remote.id)).toBe(0);
    expect((await w.config(open.id))?.version).toBe("1.0.0");
    expect((await w.config(fine.id))?.version).toBe("1.1.0");
  });

  test("a project whose default branch already has the new file is not blocked: nothing would be committed", async () => {
    const w = await world(1);
    const [p] = w.projects;
    if (!p) throw new Error("project");
    const remote = mock.addProject({
      path: `fx/same${++n}`,
      files: { [PIPELINE_FILE]: render(bunAt("1.1.0")) },
    });
    const same = await createProject(t.db, {
      organizationId: w.org.id,
      name: `same${n}`,
      gitlabProjectId: remote.id,
    });
    await w.pin(p.id, { projectId: same.id, mrIid: null, mrUrl: null });
    await exposeProduction(w, same);

    const plan = await upgradeFleet(w.deps, w.org.id, w.request(), "plan");
    expect(plan.items.find((i) => i.projectId === same.id)).toMatchObject({ status: "no_change" });
    const done = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(done.items.find((i) => i.projectId === same.id)).toMatchObject({ status: "upgraded" });
    expect(w.commits(remote.id)).toBe(0);
  });

  test("the setting is the fleet's too: with the rule off the project is upgraded", async () => {
    const w = await world(1);
    const [open] = w.projects;
    if (!open) throw new Error("projects");
    await exposeProduction(w, open);
    const deps: FleetDeps = {
      ...w.deps,
      guardrails: { off: ["production-variable-protected"], production: ["production"] },
    };
    const done = await upgradeFleet(deps, w.org.id, w.request(), "apply");
    expect(done.items.map((i) => i.status)).toEqual(["upgraded"]);
  });
});

describe("upgradeFleet: the apply", () => {
  test("puts the new version on each project's branch, keeps its merge request, and records it", async () => {
    const w = await world(3);
    const [first] = w.projects;
    if (!first) throw new Error("project");
    const mrBefore = (await w.config(first.id))?.mrIid;

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(r.items.map((i) => i.status)).toEqual(["upgraded", "upgraded", "upgraded"]);
    expect(r.items[0]).toMatchObject({
      outcome: "updated",
      existing: "none",
      code: null,
      message: null,
    });
    expect(r.items[0]?.mr?.iid).toBe(mrBefore as number);
    expect(w.recorded).toEqual(w.projects.map((p) => p.id));

    for (const p of w.projects) {
      const onBranch = await w.file(p.remote.id, PIPELINE_BRANCH);
      expect(onBranch).toBe(render(bunAt("1.1.0")));
      expect(onBranch).toContain("bun-app@1.1.0");
      expect(await w.file(p.remote.id, "main")).toBeNull(); // the default branch is never written
      expect(await w.config(p.id)).toMatchObject({ version: "1.1.0", params: {}, overrides: {} });
    }
    // and there is nothing left to do
    expect((await listFleet(w.deps, w.org.id, w.request())).projects).toEqual([]);
  });

  test("a named version is the target, even when the catalog has a newer one", async () => {
    const w = await world(1);
    const [p] = w.projects;
    if (!p) throw new Error("project");
    const deps = { ...w.deps, catalog: [...v2, bunAt("1.2.0")] };

    const r = await upgradeFleet(deps, w.org.id, w.request({ version: "1.1.0" }), "apply");
    expect(r).toMatchObject({ target: "1.1.0" });
    expect(r.items[0]).toMatchObject({ to: "1.1.0", status: "upgraded" });
    expect(await w.file(p.remote.id, PIPELINE_BRANCH)).toContain("bun-app@1.1.0");
    expect((await w.config(p.id))?.version).toBe("1.1.0");
    // and the newest is still ahead of it
    expect((await listFleet(deps, w.org.id, w.request())).projects.map((x) => x.projectId)).toEqual(
      [p.id],
    );
  });

  test("each project's own parameters and connection are used", async () => {
    const w = await world(2, (i) => ({ bunVersion: i === 0 ? "1.1" : "1.2" }));
    const second = await w.connect("second");
    const [a, b] = w.projects;
    if (!a || !b) throw new Error("projects");
    await w.pin(b.id, { connectionId: second.id });

    await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(await w.file(a.remote.id, PIPELINE_BRANCH)).toContain("image: oven/bun:1.1");
    expect(await w.file(b.remote.id, PIPELINE_BRANCH)).toContain("image: oven/bun:1.2");
    expect(w.opened.sort()).toEqual([w.connection.id, second.id].sort());
    expect((await w.config(b.id))?.connectionId).toBe(second.id); // the stored connection stays
  });

  test("a project that fails does not stop the others, and the next run only meets what is left", async () => {
    const w = await world(4);
    const [, bad] = w.projects;
    if (!bad) throw new Error("project");
    mock.inject({ method: "GET", path: new RegExp(`/projects/${bad.remote.id}$`), status: 500 });

    const first = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(first.items.map((i) => i.status)).toEqual([
      "upgraded",
      "failed",
      "upgraded",
      "upgraded",
    ]);
    expect(first.items[1]).toMatchObject({
      projectId: bad.id,
      code: "gitlab_failed",
      outcome: null,
      mr: null,
    });
    expect(first.items[1]?.message).toBeTruthy();
    expect((await w.config(bad.id))?.version).toBe("1.0.0");
    expect(w.recorded).toEqual(w.projects.filter((p) => p.id !== bad.id).map((p) => p.id));

    // resume: only the failed project is listed, and the others get no more commits
    const settled = w.projects.filter((p) => p.id !== bad.id);
    mock.requests.splice(0);
    expect(
      (await listFleet(w.deps, w.org.id, w.request())).projects.map((p) => p.projectId),
    ).toEqual([bad.id]);
    const second = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(second.items.map((i) => [i.projectId, i.status])).toEqual([[bad.id, "upgraded"]]);
    for (const p of settled) expect(w.commits(p.remote.id)).toBe(0);
    expect(w.commits(bad.remote.id)).toBe(1);
    expect((await w.config(bad.id))?.version).toBe("1.1.0");
  });

  test("a project whose stored parameters the new version refuses is blocked and left alone", async () => {
    const w = await world(2, (i) => ({ bunVersion: i === 0 ? "2" : "1" }));
    const [good, stale] = w.projects;
    if (!good || !stale) throw new Error("projects");
    // 1.1.0 only takes Bun 2
    const tight = bunAt("1.1.0", {
      manifest: {
        ...bun.manifest,
        version: "1.1.0",
        params: {
          ...bun.manifest.params,
          properties: {
            ...bun.manifest.params.properties,
            bunVersion: {
              type: "string",
              description: "x",
              default: "2",
              pattern: "^2$",
            },
          },
        },
      },
    });
    const deps = { ...w.deps, catalog: [...v1, tight] };
    mock.requests.splice(0);

    const r = await upgradeFleet(deps, w.org.id, w.request(), "apply");
    expect(r.items.map((i) => [i.projectId, i.status])).toEqual([
      [good.id, "upgraded"],
      [stale.id, "blocked"],
    ]);
    expect(r.items[1]).toMatchObject({ code: "invalid_pipeline" });
    expect(r.items[1]?.message).toContain("bunVersion");
    expect(w.commits(stale.remote.id)).toBe(0);
    expect((await w.config(stale.id))?.version).toBe("1.0.0");
    expect((await w.config(good.id))?.version).toBe("1.1.0");
  });

  test("stored overrides the renderer refuses block the project, and are not an unexpected error", async () => {
    const w = await world(1);
    const [p] = w.projects;
    if (!p) throw new Error("project");
    await w.pin(p.id, { overrides: [] as unknown as Record<string, unknown> });
    mock.requests.splice(0);
    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(r.items[0]).toMatchObject({ status: "blocked", code: "invalid_pipeline" });
    expect(w.logs).toEqual([]);
    expect(w.commits(p.remote.id)).toBe(0);
  });

  test("a lint refusal is blocked and commits nothing", async () => {
    const w = await world(1);
    const [p] = w.projects;
    if (!p) throw new Error("project");
    const broken = [
      ...v1,
      bunAt("1.1.0", { pipeline: `${bun.pipeline}\nbroken:\n  stage: check\n` }),
    ];
    mock.requests.splice(0);
    const r = await upgradeFleet({ ...w.deps, catalog: broken }, w.org.id, w.request(), "apply");
    expect(r.items[0]).toMatchObject({ status: "blocked", code: "pipeline_invalid" });
    expect(w.commits(p.remote.id)).toBe(0);
    expect((await w.config(p.id))?.version).toBe("1.0.0");
  });

  test("a project pinned to a newer version is skipped without asking GitLab, and costs no pause", async () => {
    const w = await world(3);
    const [a, b] = w.projects;
    if (!a || !b) throw new Error("projects");
    await w.pin(a.id, { version: "1.2.0" });
    mock.requests.splice(0);

    const r = await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    expect(r.items[0]).toMatchObject({
      projectId: a.id,
      from: "1.2.0",
      to: "1.1.0",
      status: "skipped",
      code: "newer",
    });
    expect(r.items.slice(1).map((i) => i.status)).toEqual(["upgraded", "upgraded"]);
    expect(mock.requests.some((q) => q.path.includes(`/projects/${a.remote.id}`))).toBe(false);
    expect((await w.config(a.id))?.version).toBe("1.2.0");
    expect(w.pauses).toEqual([FLEET_PAUSE_MS]); // two projects reached GitLab: one pause between them
  });

  test("an error that is not the platform's own is a failure with a fixed message, and the secret stays out", async () => {
    const w = await world(2);
    let calls = 0;
    const deps: FleetDeps = {
      ...w.deps,
      forge: async (c) => {
        if (++calls === 1) throw new Error(`token ${CANARY} rejected`);
        return w.deps.forge(c);
      },
    };
    const r = await upgradeFleet(deps, w.org.id, w.request(), "apply");
    expect(r.items.map((i) => i.status)).toEqual(["failed", "upgraded"]);
    expect(r.items[0]).toMatchObject({
      code: "internal",
      message: "Unexpected error: see the logs",
    });
    const all = JSON.stringify(r) + w.logs.join("\n");
    expect(all).not.toContain(CANARY);
    expect(w.logs.join("\n")).toContain("a pipeline upgrade failed unexpectedly");
  });

  test("a failure to record the result is that project's failure, not the batch's", async () => {
    const w = await world(2);
    const [a] = w.projects;
    if (!a) throw new Error("project");
    const deps: FleetDeps = {
      ...w.deps,
      record: async (projectId, applied) => {
        if (projectId === a.id) throw new DomainError("conflict", 409, "could not record");
        await w.deps.record(projectId, applied);
      },
    };
    const r = await upgradeFleet(deps, w.org.id, w.request(), "apply");
    expect(r.items.map((i) => [i.status, i.code])).toEqual([
      ["failed", "conflict"],
      ["upgraded", null],
    ]);
    // GitLab had been written to by then: the item says so
    expect(r.items[0]).toMatchObject({ outcome: "updated", mr: { iid: expect.any(Number) } });
    expect((await w.config(a.id))?.version).toBe("1.0.0"); // so the next run meets it again
  });

  test("never touches another organization's projects", async () => {
    const w = await world(1);
    const other = await world(2);
    mock.requests.splice(0);
    await upgradeFleet(w.deps, w.org.id, w.request(), "apply");
    for (const p of other.projects) {
      expect(mock.requests.some((q) => q.path.includes(`/projects/${p.remote.id}`))).toBe(false);
      expect((await other.config(p.id))?.version).toBe("1.0.0");
    }
  });
});

describe("upgradeFleet: the rate limit", () => {
  test("handles `limit` projects a call, pauses between them, and a re-run continues where it stopped", async () => {
    const w = await world(5);
    const ids = w.projects.map((p) => p.id);

    const one = await upgradeFleet(w.deps, w.org.id, w.request({ limit: 2 }), "apply");
    expect(one.items.map((i) => i.projectId)).toEqual(ids.slice(0, 2));
    expect(one.next).toBe(ids[1] ?? "");
    expect(w.pauses).toEqual([FLEET_PAUSE_MS]); // between the two, not after the last

    // no cursor: the two done are no longer listed, so the next two are
    const two = await upgradeFleet(w.deps, w.org.id, w.request({ limit: 2 }), "apply");
    expect(two.items.map((i) => i.projectId)).toEqual(ids.slice(2, 4));
    expect(two.next).toBe(ids[3] ?? "");
    const three = await upgradeFleet(w.deps, w.org.id, w.request({ limit: 2 }), "apply");
    expect(three.items.map((i) => i.projectId)).toEqual(ids.slice(4));
    expect(three.next).toBeNull();
    expect(w.pauses).toEqual([FLEET_PAUSE_MS, FLEET_PAUSE_MS, 0].slice(0, 2));
    expect(w.pauses).toHaveLength(2);
    expect(w.recorded).toEqual(ids);
  });

  test("the pause is the one configured", async () => {
    const w = await world(3);
    await upgradeFleet({ ...w.deps, pauseMs: 7 }, w.org.id, w.request(), "apply");
    expect(w.pauses).toEqual([7, 7]);
  });

  test("a cursor skips a project that keeps failing, so it cannot starve the rest", async () => {
    const w = await world(3);
    const [bad] = w.projects;
    if (!bad) throw new Error("project");
    mock.inject({
      method: "GET",
      path: new RegExp(`/projects/${bad.remote.id}$`),
      status: 500,
      times: 2,
    });
    const one = await upgradeFleet(w.deps, w.org.id, w.request({ limit: 1 }), "apply");
    expect(one.items.map((i) => i.status)).toEqual(["failed"]);
    // without the cursor the same project is met again; with it, the next one
    const after = await upgradeFleet(
      w.deps,
      w.org.id,
      w.request({ limit: 1, after: one.next ?? "" }),
      "apply",
    );
    expect(after.items.map((i) => i.projectId)).not.toContain(bad.id);
    expect(after.items.map((i) => i.status)).toEqual(["upgraded"]);
    const again = await upgradeFleet(w.deps, w.org.id, w.request({ limit: 1 }), "apply");
    expect(again.items.map((i) => i.projectId)).toEqual([bad.id]);
    mock.requests.splice(0);
  });
});

describe("lineChanges", () => {
  test.each([
    ["same text", "a\nb\n", "a\nb\n", { added: 0, removed: 0 }],
    ["a trailing newline is not a line", "a\nb\n", "a\nb", { added: 0, removed: 0 }],
    ["CRLF is a line end like LF", "a\r\nb\r\n", "a\nb\n", { added: 0, removed: 0 }],
    ["a line moved", "a\nb\nc", "c\na\nb", { added: 0, removed: 0 }],
    ["a line changed", "a\nb", "a\nc", { added: 1, removed: 1 }],
    ["a repeated line gone once", "a\na\nb", "a\nb", { added: 0, removed: 1 }],
    ["a repeated line added once", "a\nb", "a\na\nb", { added: 1, removed: 0 }],
  ])("%s", (_, from, to, expected) => {
    expect(lineChanges(from, to)).toEqual(expected);
  });

  test("with no file there, every line is new", () => {
    expect(lineChanges(null, "a\nb\nc")).toEqual({ added: 3, removed: 0 });
  });
});
