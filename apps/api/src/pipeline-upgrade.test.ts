import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  getPipelineConfig,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render, type Template } from "@orch/pipelines";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { PIPELINE_BRANCH, PIPELINE_FILE } from "./pipeline-apply";
import { FLEET_MAX_BATCH } from "./pipeline-fleet";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const reporterOn: Record<string, "reporter"> = {};
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { cookie: string }>;
type Who = keyof typeof people;
const lines: string[] = [];
const seen: string[] = [];

const v1 = await loadTemplates();
const bunApp = v1.find((c) => c.manifest.name === "bun-app") as Template;
const bun11: Template = {
  manifest: { ...bunApp.manifest, version: "1.1.0" },
  pipeline: `${bunApp.pipeline}\nsecurity:\n  stage: check\n  script:\n    - echo scan\n`,
};

const makeApp = (provider: typeof keys | undefined, templates: Template[]) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
    templates,
  });
let setup: ReturnType<typeof makeApp>; // offers 1.0.0 only: how projects get set up
let app: ReturnType<typeof makeApp>; // offers 1.1.0 as well

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  conn1 = (
    await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
  let gitlabId = 800;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { cookie: `orch_session=${session}` };
  }
  roleTable.set(801, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(802, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  roleTable.set(803, { orgRoles: {}, projectRoles: reporterOn }); // carol
  // erin: nothing
  setup = makeApp(keys, v1);
  app = makeApp(keys, [...v1, bun11]);
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

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
/** A project on a GitLab project of its own, set up from bun-app 1.0.0 through the API. */
async function seed(org = o1, connectionId = conn1) {
  const id = ++n;
  const gl = mock.addProject({ path: `fx/u${id}` });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `u${id}`,
    gitlabProjectId: gl.id,
  });
  const done = await call(
    "alice",
    "POST",
    `/organizations/${org}/projects/${project.id}/pipeline`,
    { connectionId, template: "bun-app", params: { bunVersion: "1.2" } },
    setup,
  );
  expect(done.status).toBe(200);
  const commits = () =>
    mock.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.path.includes(`/projects/${gl.id}/`) &&
        r.path.endsWith("/repository/commits"),
    ).length;
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const branch = () =>
    api.repository.getFile(gl.id, PIPELINE_FILE, PIPELINE_BRANCH).then((f) => f.content);
  return { id: project.id, gl, org, commits, branch, mrIid: done.json.mr.iid as number };
}

const base = (org = o1) => `/organizations/${org}/pipeline-upgrades`;
const list = (qs: string, who: Who | null = "alice", a = app) =>
  call(who, "GET", `${base()}${qs}`, undefined, a);
const plan = (body: object, who: Who | null = "alice", org = o1, a = app) =>
  call(who, "POST", `${base(org)}/plan`, body, a);
const apply = (body: object, who: Who | null = "alice", org = o1, a = app) =>
  call(who, "POST", base(org), body, a);
const events = (action: string, org = o1) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org)))
    .orderBy(auditEvents.at);

/** A fresh organization with a connection and its own projects, so one test's projects are not another's. */
async function island(count: number) {
  const org = await createOrganization(t.db, { slug: `i${++n}`, name: "I" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  roleTable.set(801, {
    orgRoles: { ...roleTable.get(801)?.orgRoles, [org.id]: "admin" },
    projectRoles: {},
  });
  const projects = [];
  for (let i = 0; i < count; i++) projects.push(await seed(org.id, connection.id));
  projects.sort((a, b) => a.id.localeCompare(b.id));
  return { org: org.id, connection: connection.id, projects };
}

describe("who may", () => {
  test.each([
    ["GET", ""],
    ["POST", "/plan"],
    ["POST", ""],
  ])("%s %s is for an organization admin only", async (method, suffix) => {
    const body = method === "POST" ? { template: "bun-app" } : undefined;
    const path = `${base()}${suffix}${method === "GET" ? "?template=bun-app" : ""}`;
    expect((await call("alice", method, path, body)).status).toBe(200);
    expect((await call("bob", method, path, body)).status).toBe(403); // a member
    // the organization is invisible to someone who has no role in it (a project reporter, a stranger)
    expect((await call("carol", method, path, body)).status).toBe(404);
    expect((await call("erin", method, path, body)).status).toBe(404);
    expect((await call(null, method, path, body)).status).toBe(401);
  });

  test("an admin of another organization sees none of this one's", async () => {
    const o = await island(1);
    // alice is admin of o2 but there is nothing there, and o1's projects are not in the answer
    const res = await call("alice", "GET", `${base(o2)}?template=bun-app`);
    expect(res.json.projects).toEqual([]);
    const own = await call("alice", "GET", `${base(o.org)}?template=bun-app`);
    expect(own.json.projects.map((p: { projectId: string }) => p.projectId)).toEqual(
      o.projects.map((p) => p.id),
    );
    // and o2's admin role does not reach o1's: bob is a member of o1 only
    expect((await call("bob", "GET", `${base(o2)}?template=bun-app`)).status).not.toBe(200);
  });
});

describe("GET /pipeline-upgrades", () => {
  test("lists what would move, from the database alone", async () => {
    const o = await island(3);
    mock.requests.splice(0);
    const res = await call("alice", "GET", `${base(o.org)}?template=bun-app`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ template: "bun-app", target: "1.1.0", next: null });
    expect(res.json.projects).toHaveLength(3);
    expect(res.json.projects[0]).toMatchObject({
      projectId: o.projects[0]?.id,
      version: "1.0.0",
      mrIid: o.projects[0]?.mrIid,
    });
    expect(mock.requests).toEqual([]);
  });

  test("pages with limit and after", async () => {
    const o = await island(3);
    const q = `${base(o.org)}?template=bun-app&limit=2`;
    const one = await call("alice", "GET", q);
    expect(one.json.projects).toHaveLength(2);
    expect(one.json.next).toBe(o.projects[1]?.id);
    const two = await call("alice", "GET", `${q}&after=${one.json.next}`);
    expect(two.json.projects.map((p: { projectId: string }) => p.projectId)).toEqual([
      o.projects[2]?.id,
    ]);
    expect(two.json.next).toBeNull();
  });

  test.each([
    ["no template", ""],
    ["limit 0", "?template=bun-app&limit=0"],
    ["limit over the cap", `?template=bun-app&limit=${FLEET_MAX_BATCH + 1}`],
    ["limit not a number", "?template=bun-app&limit=x"],
    ["after not an id", "?template=bun-app&after=x"],
  ])("%s is a 422", async (_, qs) => {
    expect((await list(qs)).status).toBe(422);
  });

  test("an unknown template or version is a 422 problem", async () => {
    for (const qs of ["?template=nope", "?template=bun-app&version=9.9.9"]) {
      const res = await list(qs);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("unknown_template");
    }
  });
});

describe("POST /pipeline-upgrades/plan", () => {
  test("says what would change and writes nothing: no commit, no audit, no stored change", async () => {
    const o = await island(2);
    const rows = (await events("pipeline.apply", o.org)).length;
    mock.requests.splice(0);
    const res = await plan({ template: "bun-app" }, "alice", o.org);
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { status: string }) => i.status)).toEqual([
      "would_upgrade",
      "would_upgrade",
    ]);
    expect(res.json.items[0].changes.added).toBeGreaterThan(0);
    for (const p of o.projects) expect(p.commits()).toBe(0);
    expect(mock.requests.filter((q) => q.method !== "GET" && !q.path.endsWith("/ci/lint"))).toEqual(
      [],
    );
    expect((await events("pipeline.apply", o.org)).length).toBe(rows);
    expect((await events("pipeline.upgrade", o.org)).length).toBe(0);
    for (const p of o.projects)
      expect((await getPipelineConfig(t.db, o.org, p.id))?.version).toBe("1.0.0");
  });

  test("503 without master keys, 422 for an unknown template or an unknown field", async () => {
    const o = await island(1);
    const bare = makeApp(undefined, [...v1, bun11]);
    const res = await plan({ template: "bun-app" }, "alice", o.org, bare);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect((await plan({ template: "nope" }, "alice", o.org)).status).toBe(422);
    expect((await plan({ template: "bun-app", extra: 1 }, "alice", o.org)).status).toBe(422);
    expect((await plan({ template: "bun-app", limit: 0 }, "alice", o.org)).status).toBe(422);
    expect(
      (await plan({ template: "bun-app", limit: FLEET_MAX_BATCH + 1 }, "alice", o.org)).status,
    ).toBe(422);
  });
});

describe("POST /pipeline-upgrades", () => {
  test("moves the projects: the new file on each branch, the version stored, one audit row each and one for the call", async () => {
    const o = await island(2);
    const res = await apply({ template: "bun-app" }, "alice", o.org);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ template: "bun-app", target: "1.1.0", next: null });
    expect(res.json.items.map((i: { status: string }) => i.status)).toEqual([
      "upgraded",
      "upgraded",
    ]);
    for (const [i, p] of o.projects.entries()) {
      expect(res.json.items[i]).toMatchObject({
        projectId: p.id,
        outcome: "updated",
        mr: { iid: p.mrIid },
      });
      const text = await p.branch();
      expect(text).toContain("bun-app@1.1.0");
      expect(text).toContain("image: oven/bun:1.2"); // the project's own parameter kept
      expect(await getPipelineConfig(t.db, o.org, p.id)).toMatchObject({
        version: "1.1.0",
        params: { bunVersion: "1.2" },
      });
    }

    const perProject = (await events("pipeline.apply", o.org)).filter(
      (e) => (e.metadata as { via?: string }).via === "upgrade",
    );
    expect(perProject.map((e) => e.resourceId).sort()).toEqual(o.projects.map((p) => p.id).sort());
    expect(perProject[0]?.metadata).toMatchObject({
      template: "bun-app",
      version: "1.1.0",
      outcome: "updated",
      paramNames: ["bunVersion"],
    });
    const [summary, ...rest] = await events("pipeline.upgrade", o.org);
    expect(rest).toEqual([]);
    expect(summary?.metadata).toMatchObject({
      template: "bun-app",
      target: "1.1.0",
      limit: 10,
      after: null,
      next: null,
      upgraded: 2,
      skipped: 0,
      blocked: 0,
      failed: 0,
      failedProjectIds: [],
    });

    // again: nothing is pending, no commits, and the call is still recorded
    const commits = o.projects.map((p) => p.commits());
    const again = await apply({ template: "bun-app" }, "alice", o.org);
    expect(again.json.items).toEqual([]);
    expect(o.projects.map((p) => p.commits())).toEqual(commits);
    expect((await events("pipeline.upgrade", o.org)).length).toBe(2);
  });

  test("a failing project is reported and recorded, the others go through, and a second call finishes it", async () => {
    const o = await island(3);
    const bad = o.projects[1];
    if (!bad) throw new Error("project");
    mock.inject({
      method: "GET",
      path: new RegExp(`/projects/${bad.gl.id}$`),
      status: 500,
      times: 2,
    });

    const first = await apply({ template: "bun-app" }, "alice", o.org);
    expect(first.status).toBe(200);
    expect(first.json.items.map((i: { status: string }) => i.status)).toEqual([
      "upgraded",
      "failed",
      "upgraded",
    ]);
    expect(first.json.items[1]).toMatchObject({ projectId: bad.id, code: "gitlab_failed" });
    expect((await getPipelineConfig(t.db, o.org, bad.id))?.version).toBe("1.0.0");
    const [summary] = await events("pipeline.upgrade", o.org);
    expect(summary?.metadata).toMatchObject({
      upgraded: 2,
      failed: 1,
      failedProjectIds: [bad.id],
    });

    const second = await apply({ template: "bun-app" }, "alice", o.org);
    expect(second.json.items.map((i: { projectId: string }) => i.projectId)).toEqual([bad.id]);
    expect(second.json.items[0].status).toBe("upgraded");
  });

  test("limit and after bound a call, and `next` continues it", async () => {
    const o = await island(3);
    const one = await apply({ template: "bun-app", limit: 2 }, "alice", o.org);
    expect(one.json.items).toHaveLength(2);
    expect(one.json.next).toBe(o.projects[1]?.id);
    const two = await apply(
      { template: "bun-app", limit: 2, after: one.json.next },
      "alice",
      o.org,
    );
    expect(two.json.items.map((i: { projectId: string }) => i.projectId)).toEqual([
      o.projects[2]?.id,
    ]);
    expect(two.json.next).toBeNull();
    const [first] = await events("pipeline.upgrade", o.org);
    expect(first?.metadata).toMatchObject({ limit: 2, after: null, next: o.projects[1]?.id });
  });

  test("an empty batch still leaves its row (the audit tripwire holds)", async () => {
    const o = await island(0);
    const res = await apply({ template: "bun-app" }, "alice", o.org);
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
    expect((await events("pipeline.upgrade", o.org)).length).toBe(1);
  });

  test("a project of another organization is not touched", async () => {
    const a = await island(1);
    const b = await island(1);
    const before = b.projects.map((p) => p.commits());
    await apply({ template: "bun-app" }, "alice", a.org);
    expect(b.projects.map((p) => p.commits())).toEqual(before);
    expect((await getPipelineConfig(t.db, b.org, b.projects[0]?.id ?? ""))?.version).toBe("1.0.0");
  });

  test("503 without master keys leaves everything as it was; an explicit old version is a no-op", async () => {
    const o = await island(1);
    const bare = makeApp(undefined, [...v1, bun11]);
    const res = await apply({ template: "bun-app" }, "alice", o.org, bare);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect((await getPipelineConfig(t.db, o.org, o.projects[0]?.id ?? ""))?.version).toBe("1.0.0");
    expect((await events("pipeline.upgrade", o.org)).length).toBe(0);

    const same = await apply({ template: "bun-app", version: "1.0.0" }, "alice", o.org);
    expect(same.json).toMatchObject({ target: "1.0.0", items: [] });
  });

  test("bad bodies are 422, and a body that is not JSON is 415", async () => {
    const o = await island(0);
    for (const body of [
      {},
      { template: "" },
      { template: "bun-app", limit: 1.5 },
      { template: "bun-app", after: "x" },
      { template: "bun-app", connectionId: conn1 },
    ]) {
      expect((await apply(body, "alice", o.org)).status).toBe(422);
    }
    const res = await app.handle(
      new Request(`http://localhost${base(o.org)}`, {
        method: "POST",
        headers: { cookie: people.alice.cookie, "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(res.status).toBe(415);
  });

  test("a rendered file is what render gives for the stored parameters", async () => {
    const o = await island(1);
    await apply({ template: "bun-app" }, "alice", o.org);
    expect(await o.projects[0]?.branch()).toBe(render(bun11, [{ params: { bunVersion: "1.2" } }]));
  });
});

describe("no secret leaves", () => {
  test("the GitLab token is in no response, log or audit row", async () => {
    const o = await island(1);
    // a failing project whose error text could carry something: the connection's token is the mock's
    const p = o.projects[0];
    if (!p) throw new Error("project");
    mock.inject({
      method: "GET",
      path: new RegExp(`/projects/${p.gl.id}$`),
      status: 500,
      times: 2,
    });
    await apply({ template: "bun-app" }, "alice", o.org);
    await plan({ template: "bun-app" }, "alice", o.org);
    const everything = [
      ...seen,
      ...lines,
      JSON.stringify(await t.db.select({ m: auditEvents.metadata }).from(auditEvents)),
    ].join("\n");
    expect(everything).not.toContain(mock.token);
  });
});
