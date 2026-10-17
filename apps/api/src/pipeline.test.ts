import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  createVariable,
  jobs,
  pipelineConfigs,
  projects,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
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
async function world(org = o1) {
  const id = ++n;
  const gl = mock.addProject({ path: `fx/p${id}` });
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

  test("a lint failure is a result, not an error", async () => {
    const w = await world();
    const res = await w.preview({ ...bun(), overrides: { broken: { stage: "check" } } });
    expect(res.status).toBe(200);
    expect(res.json.validation.ok).toBe(false);
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
