import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  createSyncTarget,
  createVariable,
  jobs,
  pipelineConfigs,
  projects,
  upsertUser,
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
} from "@orch/pipelines";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { PIPELINE_BRANCH, PIPELINE_FILE } from "./pipeline-apply";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
let conn2: string;
const lines: string[] = [];
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const reporterOn: Record<string, "reporter"> = {};
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { cookie: string }>;
type Who = keyof typeof people;

const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  const connect = async (organizationId: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId,
        type: "gitlab",
        name: "live",
        config: { baseUrl: mock.url },
        token: mock.token,
      })
    ).id;
  conn1 = await connect(o1);
  conn2 = await connect(o2);
  let gitlabId = 700;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { cookie: `orch_session=${session}` };
  }
  roleTable.set(701, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(702, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  roleTable.set(703, { orgRoles: {}, projectRoles: reporterOn }); // carol
  // erin: nothing
  app = makeApp(keys);
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const seen: string[] = [];
async function call(who: Who | null, method: string, path: string, body?: unknown, a = app) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

let n = 0;
/** A project on a GitLab project of its own (detected as a Bun project). */
async function world(org = o1, files?: Record<string, string>) {
  const id = ++n;
  const gl = mock.addProject({ path: `fx/p${id}`, files });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `p${id}`,
    gitlabProjectId: gl.id,
  });
  await t.db
    .update(projects)
    .set({ detectedTypes: [{ tag: "bun", confidence: "high", evidence: ["bun.lock"] }] })
    .where(eq(projects.id, project.id));
  reporterOn[project.id] = "reporter";
  const base = `/organizations/${org}/projects/${project.id}/pipeline`;
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  // the mock is shared: only this project's commits
  const commits = () =>
    mock.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.includes(`/projects/${gl.id}/`) &&
        r.path.endsWith("/repository/commits"),
    ).length;
  return {
    org,
    project: project.id,
    gl,
    base,
    api,
    commits,
    get: (who: Who | null = "alice") => call(who, "GET", base),
    preview: (body: object, who: Who | null = "alice") =>
      call(who, "POST", `${base}/preview`, body),
    apply: (body: object, who: Who | null = "alice") => call(who, "POST", base, body),
  };
}
const bun = (connectionId = conn1) => ({ connectionId, template: "bun-app" });
const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(auditEvents.at);

describe("the guardrails (POL-4)", () => {
  /** An environment `prod` that a target syncs to the production scope without protecting its variables. */
  const exposeProduction = async (w: Awaited<ReturnType<typeof world>>) => {
    await createEnvironment(t.db, {
      organizationId: w.org,
      projectId: w.project,
      name: "prod",
      slug: "prod",
    });
    await createSyncTarget(t.db, {
      organizationId: w.org,
      projectId: w.project,
      name: "main",
      type: "gitlab-variables",
      connectionId: conn1,
      config: { project: "fx/p" },
      environmentMapping: { prod: "production" },
    });
  };

  test("the preview shows what the pipeline breaks and the apply is 422, writes nothing and is not audited", async () => {
    const w = await world();
    await exposeProduction(w);
    const preview = await w.preview(bun());
    expect(preview.status).toBe(200);
    expect(preview.json.validation.ok).toBe(false);
    expect(preview.json.validation.violations).toEqual([
      {
        rule: "production-variable-protected",
        message: expect.stringContaining('environment "prod" is synced to the production scope'),
      },
    ]);

    const res = await w.apply(bun());
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("guardrail_violation");
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
    expect((await events("pipeline.apply")).filter((e) => e.projectId === w.project)).toEqual([]);
  });

  test("a project that breaks nothing has no violations to show", async () => {
    const w = await world();
    expect((await w.preview(bun())).json.validation.violations).toEqual([]);
  });

  test("with the rule switched off in the app's setting the pipeline is applied", async () => {
    const w = await world();
    await exposeProduction(w);
    const off = createApp({
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      db: t.db,
      principal: callerPrincipal({
        db: t.db,
        roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
      }),
      ready: async () => {},
      keys,
      guardrails: { off: ["production-variable-protected"], production: ["production"] },
    });
    const res = await call("alice", "POST", w.base, bun(), off);
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe("opened");
  });
});

describe("GET /pipeline", () => {
  test("a reporter sees that nothing is set up and which templates suit the project", async () => {
    const w = await world();
    const res = await w.get("carol");
    expect(res.status).toBe(200);
    expect(res.json.config).toBeNull();
    expect(res.json.recommendations).toEqual([
      { template: "bun-app", version: "1.0.0", confidence: "high", reason: "bun (bun.lock)" },
    ]);
  });

  test("lists the newest version of each template with its parameters, for a form", async () => {
    const w = await world();
    const res = await w.get("carol");
    const names = res.json.templates.map((x: { name: string }) => x.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["bun-app", "docker-image", "node-app"]));
    const bunApp = res.json.templates.find((x: { name: string }) => x.name === "bun-app");
    expect(bunApp).toMatchObject({
      version: "1.0.0",
      detects: ["bun"],
      requiresVariables: [],
      params: { required: [], properties: { bunVersion: { type: "string", default: "1" } } },
    });
    expect(bunApp.description).toBeString();
    // every string takes a length, so a form can limit it
    for (const template of res.json.templates) {
      for (const p of Object.values(template.params.properties) as { type: string }[]) {
        if (p.type === "string") expect(p).toHaveProperty("maxLength");
      }
    }
  });

  test("after an apply it shows what the project was set up with", async () => {
    const w = await world();
    const done = await w.apply({ ...bun(), params: { bunVersion: "1.2" } });
    const res = await w.get("bob");
    expect(res.json.config).toMatchObject({
      template: "bun-app",
      version: "1.0.0",
      params: { bunVersion: "1.2" },
      overrides: {},
      connectionId: conn1,
      mrIid: done.json.mr.iid,
      mrUrl: done.json.mr.url,
      renderedHash: done.json.renderedHash,
    });
  });

  test("someone who cannot see the project gets 404, and no session 401", async () => {
    const w = await world();
    expect((await w.get("erin")).status).toBe(404);
    expect((await w.get(null)).status).toBe(401);
    const elsewhere = `/organizations/${o2}/projects/${w.project}/pipeline`;
    expect((await call("alice", "GET", elsewhere)).status).toBe(404);
  });
});

describe("POST /pipeline", () => {
  test("opens one merge request, stores the configuration and writes one audit event", async () => {
    const w = await world();
    const res = await w.apply({ ...bun(), params: { bunVersion: "1.2" } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      outcome: "opened",
      committed: true,
      existing: "none",
      validation: { ok: true, lint: { valid: true, errors: [] } },
    });
    expect(res.json.mr.url).toStartWith(mock.url);

    const branch = await w.api.repository.getFile(w.gl.id, PIPELINE_FILE, PIPELINE_BRANCH);
    expect(branch.content).toContain("image: oven/bun:1.2");
    const merge = [];
    for await (const m of w.api.mergeRequests.list(w.gl.id)) merge.push(m);
    expect(merge.map((m) => m.iid)).toEqual([res.json.mr.iid]);
    expect(
      await w.api.repository.getFile(w.gl.id, PIPELINE_FILE, "main").catch(() => "absent"),
    ).toBe("absent");

    const stored = await t.db
      .select()
      .from(pipelineConfigs)
      .where(eq(pipelineConfigs.projectId, w.project));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ template: "bun-app", mrIid: res.json.mr.iid });

    const audit = (await events("pipeline.apply")).filter((e) => e.projectId === w.project);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      resourceType: "pipeline",
      resourceId: w.project,
      organizationId: w.org,
      metadata: {
        template: "bun-app",
        version: "1.0.0",
        outcome: "opened",
        committed: true,
        existing: "none",
        mrIid: res.json.mr.iid,
        paramNames: ["bunVersion"],
        overrideKeys: [],
      },
    });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain("1.2"); // names, not values
  });

  test("again with the same input: no new commit, the same merge request, the configuration kept", async () => {
    const w = await world();
    const first = await w.apply(bun());
    const commits = w.commits();
    const again = await w.apply(bun());
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ outcome: "unchanged", committed: false, mr: first.json.mr });
    expect(w.commits()).toBe(commits);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toHaveLength(1);
    expect((await events("pipeline.apply")).filter((e) => e.projectId === w.project)).toHaveLength(
      2,
    );
  });

  test("other parameters update the merge request and the stored configuration", async () => {
    const w = await world();
    await w.apply(bun());
    const res = await w.apply({ ...bun(), params: { bunVersion: "1.3" } });
    expect(res.json).toMatchObject({ outcome: "updated", committed: true });
    expect((await w.get()).json.config.params).toEqual({ bunVersion: "1.3" });
  });

  test("only an organization admin may apply or preview", async () => {
    const w = await world();
    for (const who of ["bob", "carol"] as const) {
      expect((await w.apply(bun(), who)).status).toBe(403);
      expect((await w.preview(bun(), who)).status).toBe(403);
    }
    expect((await w.apply(bun(), "erin")).status).toBe(404);
    expect((await w.apply(bun(), null)).status).toBe(401);
    expect(w.commits()).toBe(0);
    expect((await events("pipeline.apply")).filter((e) => e.projectId === w.project)).toEqual([]);
  });

  test("another organization's project or connection is not found", async () => {
    const w = await world();
    const other = await call(
      "alice",
      "POST",
      `/organizations/${o2}/projects/${w.project}/pipeline`,
      bun(conn2),
    );
    expect(other.status).toBe(404);
    const foreign = await w.apply(bun(conn2)); // o2's connection used on o1's project
    expect(foreign.status).toBe(404);
    const unknown = await w.apply(bun(Bun.randomUUIDv7()));
    expect(unknown.status).toBe(404);
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
  });

  test("a pipeline GitLab's lint refuses is 422, writes nothing and is not audited", async () => {
    const w = await world();
    const res = await w.apply({ ...bun(), overrides: { broken: { stage: "check" } } });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("pipeline_invalid");
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
    expect((await events("pipeline.apply")).filter((e) => e.projectId === w.project)).toEqual([]);
  });

  test("a bad body is refused before GitLab is reached", async () => {
    const w = await world();
    const before = mock.requests.length;
    for (const body of [
      {},
      { template: "bun-app" },
      { ...bun(), extra: 1 },
      { ...bun(), connectionId: "nope" },
      { ...bun(), environments: ["Not A Slug"] },
      { ...bun(), params: [] },
    ]) {
      const res = await w.apply(body);
      expect(res.status).toBe(422);
    }
    expect(mock.requests.length).toBe(before);
    expect((await w.apply({ ...bun(), template: "nope" })).json.code).toBe("unknown_template");
    expect((await w.apply({ ...bun(), params: { bunVersion: "1; id" } })).json.code).toBe(
      "invalid_pipeline",
    );
  });

  test("a project that is not linked to GitLab is 422", async () => {
    const loose = await createProject(t.db, { organizationId: o1, name: `loose${++n}` });
    const res = await call(
      "alice",
      "POST",
      `/organizations/${o1}/projects/${loose.id}/pipeline`,
      bun(),
    );
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("not_linked");
  });

  test("without master keys the connection cannot be opened: 503", async () => {
    const w = await world();
    const res = await call("alice", "POST", w.base, bun(), makeApp(undefined));
    expect(res.status).toBe(503);
    expect(w.commits()).toBe(0);
  });
});

describe("secret detection in a starter pipeline (SCAN-5)", () => {
  const on = (over: object = {}) => ({ ...bun(), params: { secretDetection: true }, ...over });
  const TEMPLATE = "Jobs/Secret-Detection.gitlab-ci.yml";

  test("a preview with it on is a pipeline GitLab accepts, with GitLab's template and the job", async () => {
    const w = await world();
    const res = await w.preview(on());
    expect(res.status).toBe(200);
    expect(res.json.validation).toMatchObject({ ok: true, lint: { valid: true, errors: [] } });
    expect(res.json.text).toContain(`template: ${TEMPLATE}`);
    expect(res.json.text).toContain("secret_detection:");
    expect(w.commits()).toBe(0);
  });

  test("a value that is not true or false is a 422 that names the parameter and writes nothing", async () => {
    const w = await world();
    for (const bad of ["yes", 1, null]) {
      const res = await w.apply({ ...bun(), params: { secretDetection: bad } });
      expect(res.status).toBe(422);
      expect(res.json.detail).toContain("secretDetection");
    }
    expect(w.commits()).toBe(0);
  });

  test("switching it on for a project with a pipeline is one clean update of the same merge request, and off takes it out again", async () => {
    const w = await world();
    const first = await w.apply(bun());
    const res = await w.apply(on());
    expect(res.json).toMatchObject({
      outcome: "updated",
      committed: true,
      validation: { ok: true },
      mr: first.json.mr,
    });
    const file = () => w.api.repository.getFile(w.gl.id, PIPELINE_FILE, PIPELINE_BRANCH);
    expect((await file()).content).toContain(TEMPLATE);
    expect((await w.get()).json.config.params).toEqual({ secretDetection: true });

    const off = await w.apply({ ...bun(), params: { secretDetection: false } });
    expect(off.json).toMatchObject({ outcome: "updated", committed: true });
    expect((await file()).content).not.toContain("secret_detection");
  });

  test("the audit event names the parameter, not what it was set to", async () => {
    const w = await world();
    await w.apply(on());
    const e = (await events("pipeline.apply")).filter((x) => x.projectId === w.project);
    expect(e[0]?.metadata).toMatchObject({ paramNames: ["secretDetection"] });
  });

  test("the overview warns that the runners are not known, only for a project that has it on", async () => {
    const w = await world();
    expect((await w.get("carol")).json.warnings).toEqual([]);
    await w.apply(bun());
    expect((await w.get("carol")).json.warnings).toEqual([]);
    await w.apply(on());
    const { warnings } = (await w.get("carol")).json;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not known");
    await w.apply({ ...bun(), params: { secretDetection: false } });
    expect((await w.get("carol")).json.warnings).toEqual([]);
  });
});

describe("POST /pipeline/preview", () => {
  test("shows the file and GitLab's verdict, and changes nothing", async () => {
    const w = await world();
    const res = await w.preview({ ...bun(), params: { bunVersion: "1.2" } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      existing: "none",
      template: { name: "bun-app", version: "1.0.0" },
      validation: { ok: true },
    });
    expect(res.json.text).toContain("image: oven/bun:1.2");
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
    expect((await events("pipeline.apply")).filter((e) => e.projectId === w.project)).toEqual([]);
  });

  test("shows our own file on the default branch for a diff, and none when it is not there", async () => {
    const none = await world();
    expect((await none.preview(bun())).json.current).toBeNull();

    const same = await world();
    const text = (await same.preview(bun())).json.text;
    const identical = await world(o1, { [PIPELINE_FILE]: text });
    expect((await identical.preview(bun())).json).toMatchObject({
      existing: "identical",
      current: text,
    });

    const older = await world(o1, { [PIPELINE_FILE]: text.replace("oven/bun:1", "oven/bun:0") });
    const res = await older.preview(bun());
    expect(res.json.existing).toBe("generated");
    expect(res.json.current).toContain("oven/bun:0");
  });

  test("a file written by hand is never shown back: it may hold anything", async () => {
    const canary = `SEKRIT-handwritten-${Bun.randomUUIDv7()}`;
    const mine = `stages: [mine]\nmine:\n  stage: mine\n  script: [echo ${canary}]\n`;
    const w = await world(o1, { [PIPELINE_FILE]: mine });
    const res = await w.preview(bun());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ existing: "hand-written", current: null });
    expect(res.text.includes(canary)).toBe(false);
  });

  test("a lint failure is a result, not an error", async () => {
    const w = await world();
    const res = await w.preview({ ...bun(), overrides: { broken: { stage: "check" } } });
    expect(res.status).toBe(200);
    expect(res.json.validation.ok).toBe(false);
  });
});

describe("the include mode", () => {
  const into = { project: "fx/templates", ref: "main" };
  const thin = (extra: object = {}) => ({ ...bun(), mode: "include", include: into, ...extra });
  beforeAll(async () => {
    const template = (await loadTemplates()).find((c) => c.manifest.name === "bun-app");
    if (!template) throw new Error("the bun-app template is missing");
    mock.addProject({
      path: into.project,
      files: { [includePath(template.manifest)]: includeFile(template) },
    });
  });

  test("a preview shows the thin file and says which mode it is", async () => {
    const w = await world();
    const res = await w.preview(thin({ params: { bunVersion: "1.2" } }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ mode: "include", validation: { ok: true } });
    expect(res.json.text).toContain("project: fx/templates");
    expect(res.json.text).toContain("file: bun-app/1.0.0/pipeline.yml");
    expect(res.json.text).toContain('bunVersion: "1.2"');
    expect(res.json.text).not.toContain("image: oven/bun");
    expect(w.commits()).toBe(0);
  });

  test("an apply stores the templates project, audits the mode and the project reads it back", async () => {
    const w = await world();
    const res = await w.apply(thin());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      config: { mode: "include", includeProject: "fx/templates", includeRef: "main" },
      outcome: "opened",
      committed: true,
    });
    const branch = await w.api.repository.getFile(w.gl.id, PIPELINE_FILE, PIPELINE_BRANCH);
    expect(branch.content).toStartWith("# Generated by orch from template bun-app@1.0.0");
    expect(branch.content).not.toContain("image: oven/bun");

    expect((await w.get("bob")).json.config).toMatchObject({
      mode: "include",
      includeProject: "fx/templates",
      includeRef: "main",
    });
    const audit = (await events("pipeline.apply")).filter((e) => e.projectId === w.project);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({
      mode: "include",
      includeProject: "fx/templates",
      includeRef: "main",
      outcome: "opened",
    });

    // eject: the same call without the templates project writes the full pipeline to the same branch
    const ejected = await w.apply(bun());
    expect(ejected.json).toMatchObject({
      config: { mode: "inline", includeProject: null, includeRef: null },
      outcome: "updated",
      mr: res.json.mr,
    });
    expect((await w.get("bob")).json.config).toMatchObject({
      mode: "inline",
      includeProject: null,
      includeRef: null,
    });
  });

  test("a body that mixes the modes up, or names an unpublished template, is refused and writes nothing", async () => {
    const w = await world();
    const before = mock.requests.length;
    for (const body of [
      thin({ mode: "outline" }),
      { ...bun(), mode: "outline" },
      thin({ include: { ...into, extra: 1 } }),
      thin({ include: { project: "" } }),
      thin({ include: { project: "x".repeat(256) } }),
    ])
      expect((await w.apply(body)).status).toBe(422);
    expect(mock.requests.length).toBe(before);

    const unpaired = [
      [{ ...bun(), mode: "include" }, "The include mode needs the templates project"],
      [
        { ...bun(), include: into },
        "A templates project goes with the include and component modes alone",
      ],
    ] as const;
    for (const [body, message] of unpaired) {
      const res = await w.apply(body);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "invalid_pipeline", detail: message });
    }
    expect((await w.apply(thin({ overrides: { include: [] } }))).json.code).toBe(
      "invalid_pipeline",
    );
    const missing = await w.apply(thin({ include: { project: "fx/not-there" } }));
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe("pipeline_invalid");
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
  });

  test("a member cannot apply it, and nobody is let in without a session", async () => {
    const w = await world();
    expect((await w.apply(thin(), "bob")).status).toBe(403);
    expect((await w.apply(thin(), null)).status).toBe(401);
    expect(w.commits()).toBe(0);
  });
});

describe("the component mode", () => {
  const into = { project: "fx/catalog", ref: "1.0.0" };
  const comp = (extra: object = {}) => ({ ...bun(), mode: "component", include: into, ...extra });
  beforeAll(async () => {
    const template = (await loadTemplates()).find((c) => c.manifest.name === "bun-app");
    if (!template) throw new Error("the bun-app template is missing");
    mock.addProject({
      path: into.project,
      files: { [componentPath(template.manifest)]: componentFile(template) },
    });
    mock.addTag(into.project, "1.0.0");
  });

  test("a preview shows the thin file, which component at which version, and writes nothing", async () => {
    const w = await world();
    const res = await w.preview(comp({ params: { bunVersion: "1.2" } }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ mode: "component", validation: { ok: true } });
    expect(res.json.text).toContain("component: $CI_SERVER_FQDN/fx/catalog/bun-app@1.0.0");
    expect(res.json.text).toContain('bunVersion: "1.2"');
    expect(res.json.text).not.toContain("image: oven/bun");
    expect(w.commits()).toBe(0);
  });

  test("an apply stores the catalog project and version, audits them, and a switch back to inline is clean", async () => {
    const w = await world();
    const res = await w.apply(comp());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      config: { mode: "component", includeProject: "fx/catalog", includeRef: "1.0.0" },
      outcome: "opened",
      committed: true,
    });
    const branch = await w.api.repository.getFile(w.gl.id, PIPELINE_FILE, PIPELINE_BRANCH);
    expect(branch.content).toContain("bun-app@1.0.0");
    expect(branch.content).not.toContain("image: oven/bun");
    expect((await w.get("bob")).json.config).toMatchObject({
      mode: "component",
      includeProject: "fx/catalog",
      includeRef: "1.0.0",
    });
    const audit = (await events("pipeline.apply")).filter((e) => e.projectId === w.project);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({
      mode: "component",
      includeProject: "fx/catalog",
      includeRef: "1.0.0",
      outcome: "opened",
    });

    const ejected = await w.apply(bun());
    expect(ejected.json).toMatchObject({
      config: { mode: "inline", includeProject: null, includeRef: null },
      outcome: "updated",
      mr: res.json.mr,
    });
  });

  test("a branch, ~latest, no version or an unpublished one is refused and writes nothing", async () => {
    const w = await world();
    for (const ref of ["main", "~latest", "v1.0.0"]) {
      const res = await w.apply(comp({ include: { project: into.project, ref } }));
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("invalid_pipeline");
    }
    const none = await w.apply(comp({ include: { project: into.project } }));
    expect(none.status).toBe(422);
    expect(none.json.code).toBe("invalid_pipeline");
    const gone = await w.apply(comp({ include: { project: into.project, ref: "9.9.9" } }));
    expect(gone.status).toBe(422);
    expect(gone.json.code).toBe("pipeline_invalid");
    expect(w.commits()).toBe(0);
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project)),
    ).toEqual([]);
  });

  test("a member cannot apply it, and nobody is let in without a session", async () => {
    const w = await world();
    expect((await w.apply(comp(), "bob")).status).toBe(403);
    expect((await w.apply(comp(), null)).status).toBe(401);
    expect(w.commits()).toBe(0);
  });
});

test("no secret reaches a response, a row, a job or a log line", async () => {
  const w = await world();
  const canary = `SEKRIT-pipeline-${Bun.randomUUIDv7()}`;
  await createVariable(t.db, keys, {
    organizationId: w.org,
    projectId: w.project,
    key: "DEPLOY_TOKEN",
    kind: "secret",
    value: canary,
    actor: { kind: "user", id: "u1" },
  });
  await w.preview(bun());
  await w.apply(bun());
  await w.apply(bun());
  await w.apply({ ...bun(), mode: "include", include: { project: "fx/templates" } });
  await w.apply({ ...bun(), mode: "component", include: { project: "fx/catalog", ref: "1.0.0" } });
  const haystack = [
    ...seen,
    JSON.stringify(await t.db.select().from(pipelineConfigs)),
    JSON.stringify(await t.db.select().from(auditEvents)),
    JSON.stringify(await t.db.select().from(jobs)),
    JSON.stringify(mock.requests),
    ...lines,
  ].join("\n");
  for (const secret of [canary, mock.token]) expect(haystack.includes(secret)).toBe(false);
});
