import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type DetectedType, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  projects,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol", { id: string; cookie: string }>;

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
    loopbackConnections: true,
  });
let app: ReturnType<typeof makeApp>;
let conn: string; // alice's connection in o1
let conn2: string; // a connection in o2

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const found = (c = conn, org = o1) => `/organizations/${org}/connections/${c}/gitlab-projects`;
const imports = (c = conn, org = o1) => `/organizations/${org}/connections/${c}/imports`;
const run = (ids: number[], c = conn, org = o1) =>
  call("alice", "POST", imports(c, org), { gitlabProjectIds: ids });
const importEvents = () =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, "project.import"));

let n = 0;
const add = (files: Record<string, string>, over: { defaultBranch?: string | null } = {}) =>
  mock.addProject({ path: `fx/p${++n}`, files, ...over });
type Imported = { outcome: string; project: { types: DetectedType[] } };
const tagsOf = (r: Imported | undefined) => (r?.project.types ?? []).map((x) => x.tag);

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["read_api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  app = makeApp(keys);
  const make = async (org: string) => {
    const res = await call("alice", "POST", `/organizations/${org}/connections`, {
      type: "gitlab",
      name: "gl",
      baseUrl: mock.url,
      token: mock.token,
    });
    expect(res.status).toBe(201);
    return res.json.id as string;
  };
  conn = await make(o1);
  conn2 = await make(o2);
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

describe("importing projects", () => {
  test("detects what each repository is: Bun, Node, Docker, Terraform, mixed, empty", async () => {
    const bun = add({ "bun.lock": "", "package.json": "{}", "src/index.ts": "" });
    const node = add({ "package.json": "{}", "package-lock.json": "{}" });
    const docker = add({ Dockerfile: "FROM scratch", "README.md": "" });
    const tf = add({ "main.tf": "", "terragrunt.hcl": "" });
    const mixed = add({
      "bun.lock": "",
      Dockerfile: "",
      "infra/main.tf": "",
      "infra/terragrunt.hcl": "",
    });
    const empty = add({}, { defaultBranch: null });
    const plain = add({ "README.md": "" });
    const dirs = add({ "Dockerfile/notes.txt": "", "bun.lock/x.txt": "" }); // folders named like markers
    const res = await run([bun, node, docker, tf, mixed, empty, plain, dirs].map((p) => p.id));
    expect(res.status).toBe(200);
    const by = new Map<number, Imported>(
      res.json.results.map((r: { gitlabProjectId: number }) => [r.gitlabProjectId, r]),
    );
    const tags = (p: { id: number }) => tagsOf(by.get(p.id));
    expect(tags(bun)).toEqual(["bun"]);
    expect(tags(node)).toEqual(["node"]);
    expect(tags(docker)).toEqual(["docker"]);
    expect(tags(tf)).toEqual(["terraform", "terragrunt"]);
    expect(tags(mixed)).toEqual(["bun", "docker", "terraform", "terragrunt"]);
    expect(tags(empty)).toEqual([]);
    expect(tags(plain)).toEqual([]);
    expect(tags(dirs)).toEqual([]);
    expect([...by.values()].every((r) => r.outcome === "created")).toBe(true);
    expect(by.get(bun.id)?.project.types).toEqual([
      { tag: "bun", confidence: "high", evidence: ["bun.lock"] },
    ]);
    // The project is the GitLab one: its path as name, its branch, the link.
    const [row] = await t.db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, o1), eq(projects.gitlabProjectId, bun.id)));
    expect(row).toMatchObject({ name: bun.path, defaultBranch: "main" });
    expect(row?.detectedTypes).toEqual(by.get(bun.id)?.project.types);
  });

  test("an empty repository comes in on the default branch name", async () => {
    const empty = add({}, { defaultBranch: null });
    const res = await run([empty.id]);
    expect(res.json.results[0]).toMatchObject({
      outcome: "created",
      project: { defaultBranch: "main", types: [] },
    });
  });

  test("the project reads back with its types, and a hand-made one has none", async () => {
    const p = add({ Dockerfile: "" });
    const made = (await run([p.id])).json.results[0].project;
    const got = await call("alice", "GET", `/organizations/${o1}/projects/${made.id}`);
    expect(got.json.types).toEqual([
      { tag: "docker", confidence: "high", evidence: ["Dockerfile"] },
    ]);
    // FRG-24: a GitLab project says so, and that GitLab can do all of it
    expect(got.json).toMatchObject({
      forge: "gitlab",
      capabilities: { ciLint: true, runners: true },
    });
    const byHand = await call("alice", "POST", `/organizations/${o1}/projects`, {
      name: "by-hand",
    });
    expect(byHand.json.types).toEqual([]);
  });

  test("importing again changes nothing: same projects, updated, one audit row per call", async () => {
    const [a, b] = [add({ "bun.lock": "" }), add({ Dockerfile: "" })];
    const first = await run([a.id, b.id]);
    const before = (await importEvents()).length;
    const again = await run([a.id, b.id]);
    expect(again.json.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "updated",
      "updated",
    ]);
    expect(again.json.results.map((r: { project: { id: string } }) => r.project.id)).toEqual(
      first.json.results.map((r: { project: { id: string } }) => r.project.id),
    );
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, a.id)),
    ).toHaveLength(1);
    expect((await importEvents()).length).toBe(before + 1);
  });

  test("an import binds the project to its connection, and the list shows it only there", async () => {
    const org = (await createOrganization(t.db, { slug: "bound", name: "Bound" })).id;
    roleTable.set(901, {
      orgRoles: { [o1]: "admin", [o2]: "admin", [org]: "admin" },
      projectRoles: {},
    });
    const make = async () => {
      const res = await call("alice", "POST", `/organizations/${org}/connections`, {
        type: "gitlab",
        name: `gl${++n}`,
        baseUrl: mock.url,
        token: mock.token,
      });
      return res.json.id as string;
    };
    const [a, b] = [await make(), await make()];
    const p = add({ "bun.lock": "" });
    const done = await run([p.id], a, org);
    expect(done.json.results[0].outcome).toBe("created");
    const [row] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.id, done.json.results[0].project.id));
    expect(row?.connectionId).toBe(a);
    const listed = (c: string) =>
      call("alice", "GET", `${found(c, org)}?limit=100&search=${p.path}`).then((r) => r.json.items);
    expect(await listed(a)).toMatchObject([{ gitlabProjectId: p.id, projectId: row?.id }]);
    expect(await listed(b)).toMatchObject([{ gitlabProjectId: p.id, projectId: null }]);
    // The connection the project came through is not taken from under it.
    const del = await call("alice", "DELETE", `/organizations/${org}/connections/${a}`);
    expect([del.status, del.json.code]).toEqual([409, "connection_in_use"]);
    expect((await call("alice", "DELETE", `/organizations/${org}/connections/${b}`)).status).toBe(
      204,
    );
  });

  test("an import adopts a project linked before connections were recorded", async () => {
    const org = (await createOrganization(t.db, { slug: "legacy", name: "Legacy" })).id;
    roleTable.set(901, {
      orgRoles: { [o1]: "admin", [o2]: "admin", [org]: "admin" },
      projectRoles: {},
    });
    const made = await call("alice", "POST", `/organizations/${org}/connections`, {
      type: "gitlab",
      name: "gl",
      baseUrl: mock.url,
      token: mock.token,
    });
    const p = add({ "bun.lock": "" });
    const mine = await createProject(t.db, {
      organizationId: org,
      name: "mine",
      gitlabProjectId: p.id,
    });
    const done = await run([p.id], made.json.id, org);
    expect(done.json.results[0]).toMatchObject({ outcome: "updated", project: { id: mine.id } });
    const [row] = await t.db.select().from(projects).where(eq(projects.id, mine.id));
    expect(row?.connectionId).toBe(made.json.id);
  });

  test("a rename here survives a re-import", async () => {
    const p = add({ "bun.lock": "" });
    const made = (await run([p.id])).json.results[0].project;
    const renamed = await call("alice", "PATCH", `/organizations/${o1}/projects/${made.id}`, {
      name: "my-name",
    });
    expect(renamed.status).toBe(200);
    const again = (await run([p.id])).json.results[0];
    expect(again).toMatchObject({ outcome: "updated", project: { id: made.id, name: "my-name" } });
  });

  test("one audit row for the import, naming what it touched, and no token", async () => {
    const [a, b] = [add({ "bun.lock": "" }), add({})];
    const res = await run([a.id, b.id, 987_654]);
    const [event] = (await importEvents()).slice(-1);
    expect(event).toMatchObject({
      action: "project.import",
      resourceType: "connection",
      resourceId: conn,
      organizationId: o1,
    });
    const ids = res.json.results
      .filter((r: { project?: unknown }) => r.project)
      .map((r: { project: { id: string } }) => r.project.id);
    expect(event?.metadata).toEqual({ requested: 3, created: ids, updated: [], failed: [987_654] });
    expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toContain(mock.token);
    expect(res.text + lines.join("\n")).not.toContain(mock.token);
  });

  test("a project GitLab does not know, or a name already taken, fails alone", async () => {
    const [ok, clash] = [add({ "bun.lock": "" }), add({ Dockerfile: "" })];
    await createProject(t.db, { organizationId: o1, name: clash.path });
    const res = await run([ok.id, 987_001, clash.id]);
    expect(res.status).toBe(200);
    expect(res.json.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "created",
      "failed",
      "failed",
    ]);
    expect(res.json.results[1]).toMatchObject({ reason: "not_found" });
    expect(res.json.results[2]).toMatchObject({ gitlabProjectId: clash.id, reason: "name_taken" });
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, ok.id)),
    ).toHaveLength(1);
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, clash.id)),
    ).toHaveLength(0);
  });

  test("a project the token may not read fails alone, in fixed words", async () => {
    const [ok, no] = [add({ "bun.lock": "" }), add({ Dockerfile: "" })];
    mock.inject({ path: `/api/v4/projects/${no.id}`, status: 403 });
    const res = await run([no.id, ok.id]);
    expect(res.status).toBe(200);
    expect(res.json.results[0]).toMatchObject({
      outcome: "failed",
      reason: "forbidden",
      message: "GitLab refused the token for this project.",
    });
    expect(res.json.results[1].outcome).toBe("created");
  });

  test("a branch GitLab has no tree for is an empty repository, not a failure", async () => {
    const p = add({ "bun.lock": "" });
    mock.inject({ path: `/api/v4/projects/${p.id}/repository/tree`, status: 404 });
    const res = await run([p.id]);
    expect(res.json.results[0]).toMatchObject({ outcome: "created", project: { types: [] } });
  });

  test("vendored and installed code is not the project", async () => {
    const p = add({ "node_modules/x/package.json": "{}", "vendor/Dockerfile": "" });
    expect((await run([p.id])).json.results[0].project.types).toEqual([]);
  });

  test("a path or branch the platform would not accept is refused for that project", async () => {
    const long = mock.addProject({ path: `fx/${"a".repeat(98)}` });
    const odd = add({}, { defaultBranch: "has space" });
    const res = await run([long.id, odd.id]);
    expect(res.json.results.map((r: { reason: string }) => r.reason)).toEqual([
      "unsupported",
      "unsupported",
    ]);
  });

  test("only a GitLab connection is used against GitLab", async () => {
    const other = await createConnection(t.db, keys, {
      organizationId: o1,
      type: "other",
      name: "not-gitlab",
      config: { baseUrl: mock.url },
      token: "another-systems-secret",
    });
    const seen = mock.requests.length;
    for (const [method, path, body] of [
      ["GET", found(other.id), undefined],
      ["POST", imports(other.id), { gitlabProjectIds: [1] }],
      ["POST", `/organizations/${o1}/connections/${other.id}/test`, undefined],
    ] as const) {
      const res = await call("alice", method, path, body);
      expect([path, res.status, res.json.code]).toEqual([path, 422, "connection_type"]);
    }
    expect(mock.requests.length).toBe(seen); // the secret never left
  });

  test("repeated ids are one project", async () => {
    const p = add({ "bun.lock": "" });
    const res = await run([p.id, p.id]);
    expect(res.json.results).toHaveLength(1);
  });

  test("reads at most 5000 entries below the top level, reports it, and still finds the top", async () => {
    const files: Record<string, string> = { "bun.lock": "" };
    for (let i = 0; i < 5200; i++) files[`a/f${String(i).padStart(5, "0")}`] = "";
    const big = add(files);
    const treeCalls = () => mock.requests.filter((r) => r.path.endsWith("/repository/tree")).length;
    const before = treeCalls();
    const res = await run([big.id]);
    expect(res.json.results[0]).toMatchObject({
      outcome: "created",
      truncated: true,
      project: { types: [{ tag: "bun", confidence: "high", evidence: ["bun.lock"] }] },
    });
    // One page for the top level, then the 5001st entry (page 51) is where the scan gives up.
    expect(treeCalls() - before).toBe(1 + 51);
  });

  test("folders count towards the cap, so a tree of folders is bounded too", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) files[`d${String(i).padStart(4, "0")}/f`] = ""; // 6000 entries
    const res = await run([add(files).id]);
    expect(res.json.results[0]).toMatchObject({ outcome: "created", truncated: true });
  });

  test("a small repository is not truncated, and a folder-only top level is read whole", async () => {
    const p = add({ "bun.lock": "", "src/a.ts": "" });
    expect((await run([p.id])).json.results[0].truncated).toBe(false);
  });

  test("a GitLab failure fails the whole import with fixed words and writes nothing", async () => {
    const [a, b] = [add({ "bun.lock": "" }), add({ Dockerfile: "" })];
    const events = (await importEvents()).length;
    mock.inject({ path: `/api/v4/projects/${b.id}`, status: 401 });
    const res = await run([a.id, b.id]);
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.json.detail).toContain("GitLab rejected the token");
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, a.id)),
    ).toHaveLength(0);
    expect((await importEvents()).length).toBe(events);
    mock.inject({ path: `/api/v4/projects/${a.id}`, status: 500, times: 2 }); // one retry
    expect((await run([a.id])).status).toBe(502);
  });

  test("a body that is not a list of 1 to 25 GitLab project ids is a 422", async () => {
    for (const bad of [
      {},
      { gitlabProjectIds: [] },
      { gitlabProjectIds: Array.from({ length: 26 }, (_, i) => i + 1) },
      { gitlabProjectIds: [1.5] },
      { gitlabProjectIds: [0] },
      { gitlabProjectIds: ["1"] },
      { gitlabProjectIds: [1], extra: true },
    ]) {
      const res = await call("alice", "POST", imports(), bad);
      expect([res.status, JSON.stringify(bad)]).toEqual([422, JSON.stringify(bad)]);
    }
  });
});

describe("finding projects", () => {
  test("lists what the connection sees, in id order, with a cursor and what is imported", async () => {
    const fresh = createMockGitlab({ scopes: ["read_api"] });
    // An organization of its own: this mock's ids start at 1 like the other's.
    const o3 = (await createOrganization(t.db, { slug: "three", name: "Three" })).id;
    roleTable.set(901, {
      orgRoles: { [o1]: "admin", [o2]: "admin", [o3]: "admin" },
      projectRoles: {},
    });
    try {
      const c = await call("alice", "POST", `/organizations/${o3}/connections`, {
        type: "gitlab",
        name: "own",
        baseUrl: fresh.url,
        token: fresh.token,
      });
      expect(c.status).toBe(201);
      const ps = [1, 2, 3, 4, 5].map((i) =>
        fresh.addProject({ path: `lf/p${i}`, archived: i === 4 }),
      );
      const first = await call("alice", "GET", `${found(c.json.id, o3)}?limit=2`);
      expect(first.status).toBe(200);
      expect(first.json.items).toEqual([
        {
          gitlabProjectId: ps[0]?.id,
          path: "lf/p1",
          defaultBranch: "main",
          archived: false,
          projectId: null,
        },
        {
          gitlabProjectId: ps[1]?.id,
          path: "lf/p2",
          defaultBranch: "main",
          archived: false,
          projectId: null,
        },
      ]);
      const second = await call(
        "alice",
        "GET",
        `${found(c.json.id, o3)}?limit=2&cursor=${first.json.nextCursor}`,
      );
      expect(second.json.items.map((i: { path: string }) => i.path)).toEqual(["lf/p3", "lf/p4"]);
      const last = await call(
        "alice",
        "GET",
        `${found(c.json.id, o3)}?limit=2&cursor=${second.json.nextCursor}`,
      );
      expect([last.json.items.length, last.json.nextCursor]).toEqual([1, null]);

      const bumped = await call("alice", "POST", imports(c.json.id, o3), {
        gitlabProjectIds: [ps[1]?.id],
      });
      const all = await call("alice", "GET", `${found(c.json.id, o3)}?limit=100`);
      expect(all.json.items.map((i: { projectId: string | null }) => i.projectId)).toEqual([
        null,
        bumped.json.results[0].project.id,
        null,
        null,
        null,
      ]);
      expect(await call("alice", "GET", `${found(c.json.id, o3)}?archived=true`)).toMatchObject({
        json: { items: [{ path: "lf/p4", archived: true }] },
      });
      expect(
        (await call("alice", "GET", `${found(c.json.id, o3)}?search=p5`)).json.items,
      ).toHaveLength(1);
      // A search and a cursor together: the filter holds across pages.
      const q = `${found(c.json.id, o3)}?search=lf/p&limit=2`;
      const hits = await call("alice", "GET", q);
      const next = await call("alice", "GET", `${q}&cursor=${hits.json.nextCursor}`);
      expect([hits, next].map((r) => r.json.items.map((i: { path: string }) => i.path))).toEqual([
        ["lf/p1", "lf/p2"],
        ["lf/p3", "lf/p4"],
      ]);
    } finally {
      fresh.stop();
    }
  });

  test("another organization's import of the same GitLab project is not shown as imported", async () => {
    const p = add({ "bun.lock": "" });
    await run([p.id], conn2, o2);
    const res = await call("alice", "GET", `${found()}?limit=100&search=${p.path}`);
    expect(res.json.items).toMatchObject([{ gitlabProjectId: p.id, projectId: null }]);
  });

  test("a bad cursor or limit is a 400 or 422", async () => {
    expect((await call("alice", "GET", `${found()}?cursor=zzz`)).status).toBe(400);
    expect((await call("alice", "GET", `${found()}?limit=0`)).status).toBe(422);
    expect((await call("alice", "GET", `${found()}?limit=101`)).status).toBe(422);
  });

  test("a GitLab failure is a 502 in fixed words", async () => {
    mock.inject({ path: "/api/v4/projects", status: 401 });
    const res = await call("alice", "GET", found());
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.json.detail).toContain("GitLab rejected the token");
  });
});

describe("who may", () => {
  test("only an org admin, and only through a connection of their own organization", async () => {
    const p = add({ "bun.lock": "" });
    for (const [who, org, status] of [
      [undefined, o1, 401],
      ["bob", o1, 403], // a member
      ["carol", o1, 404], // no role: the organization is not theirs to see
    ] as const) {
      expect((await call(who, "GET", found(conn, org))).status).toBe(status);
      expect(
        (await call(who, "POST", imports(conn, org), { gitlabProjectIds: [p.id] })).status,
      ).toBe(status);
    }
    // Admin of o1 using o2's connection through o1's path, or an unknown one.
    expect((await call("alice", "GET", found(conn2, o1))).status).toBe(404);
    expect((await run([p.id], conn2, o1)).status).toBe(404);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call("alice", "GET", found(unknown))).status).toBe(404);
    expect((await run([p.id], unknown)).status).toBe(404);
    // Nobody got to GitLab or the database.
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, p.id)),
    ).toHaveLength(0);
  });

  test("without a master key it answers 503, not a guess", async () => {
    const bare = makeApp(undefined);
    expect((await call("alice", "GET", found(), undefined, bare)).json.code).toBe(
      "secrets_unavailable",
    );
    const res = await call("alice", "POST", imports(), { gitlabProjectIds: [1] }, bare);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
  });
});
