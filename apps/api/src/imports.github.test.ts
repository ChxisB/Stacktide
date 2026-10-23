import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createSession,
  importProject,
  projects,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub } from "@orch/github/mock";
import { createMockGitlab } from "@orch/gitlab/mock";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

// FRG-15: the import and discovery routes work through a GitHub connection the way they do through a GitLab one.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-1234";

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let lab: ReturnType<typeof createMockGitlab>;
let org: string;
let github: string;
let gitlab: string;
let app: ReturnType<typeof createApp>;
const people = {} as Record<"alice" | "bob", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

async function call(who: keyof typeof people, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: people[who] };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const base = (c: string) => `/organizations/${org}/connections/${c}`;
const found = (c = github) => `${base(c)}/gitlab-projects`;
const run = (ids: number[], c = github) =>
  call("alice", "POST", `${base(c)}/imports`, { gitlabProjectIds: ids });

let n = 0;
const repo = (files: Record<string, string>) => hub.addRepo("acme", `svc${++n}`, { files });

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  lab = createMockGitlab({ scopes: ["read_api"] });
  org = (await createOrganization(t.db, { slug: "gh", name: "Gh" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
  }
  roleTable.set(901, { orgRoles: { [org]: "admin" }, projectRoles: {} });
  roleTable.set(902, { orgRoles: { [org]: "member" }, projectRoles: {} });
  app = createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    loopbackConnections: true,
  });
  github = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "github",
      name: "hub",
      config: { baseUrl: hub.url },
      token: TOKEN,
    })
  ).id;
  gitlab = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "lab",
      config: { baseUrl: lab.url },
      token: lab.token,
    })
  ).id;
});
afterAll(async () => {
  hub.stop();
  lab.stop();
  await t.drop();
});

describe("repositories of a GitHub connection", () => {
  test("are listed with their path and branch, and read as imported once they are", async () => {
    const r = repo({ "bun.lock": "", Dockerfile: "" });
    const before = await call("alice", "GET", `${found()}?limit=100&search=${r.name}`);
    expect(before.status).toBe(200);
    expect(before.json.items).toEqual([
      {
        gitlabProjectId: r.id,
        path: `acme/${r.name}`,
        defaultBranch: "main",
        archived: false,
        projectId: null,
      },
    ]);

    const done = await run([r.id]);
    expect(done.status).toBe(200);
    expect(done.json.results[0]).toMatchObject({
      gitlabProjectId: r.id,
      outcome: "created",
      truncated: false,
      project: { name: `acme/${r.name}`, defaultBranch: "main" },
    });
    expect(done.json.results[0].project.types.map((x: { tag: string }) => x.tag)).toEqual([
      "bun",
      "docker",
    ]);

    // the row is bound to the GitHub connection, so a GitLab project with the same number is another project
    const [row] = await t.db.select().from(projects).where(eq(projects.gitlabProjectId, r.id));
    expect(row).toMatchObject({ connectionId: github, name: `acme/${r.name}` });
    const after = await call("alice", "GET", `${found()}?limit=100&search=${r.name}`);
    expect(after.json.items[0].projectId).toBe(done.json.results[0].project.id);
    // and importing again refreshes it
    expect((await run([r.id])).json.results[0].outcome).toBe("updated");
  });

  test("the project says which forge it is on and what that forge cannot do (FRG-24)", async () => {
    const r = repo({ "bun.lock": "" });
    const done = (await run([r.id])).json.results[0].project;
    expect(done).toMatchObject({
      forge: "github",
      capabilities: { ciLint: false, approvalState: true },
    });
    const one = await call("alice", "GET", `/organizations/${org}/projects/${done.id}`);
    const listed = await call("alice", "GET", `/organizations/${org}/projects?limit=100`);
    const inList = listed.json.items.find((x: { id: string }) => x.id === done.id);
    expect(one.json).toEqual(done);
    expect(inList).toEqual(done);
    // renaming it keeps the forge; a project made by hand has no connection and is a GitLab one
    const renamed = await call("alice", "PATCH", `/organizations/${org}/projects/${done.id}`, {
      defaultBranch: "trunk",
    });
    expect(renamed.json).toMatchObject({ forge: "github", defaultBranch: "trunk" });
    const byHand = await call("alice", "POST", `/organizations/${org}/projects`, {
      name: `hand-${r.id}`,
    });
    expect(byHand.json).toMatchObject({ forge: "gitlab", capabilities: { ciLint: true } });
  });

  test("a GitLab project with the same number is neither imported nor shown as the repository", async () => {
    const r = repo({ "bun.lock": "" });
    const g = lab.addProject({ path: `fx/same${r.id}`, files: { Dockerfile: "" } });
    // make the two numbers the same: a GitLab project is imported first under the id the repository has
    const taken = await t.db.transaction((tx) =>
      importProject(tx, {
        organizationId: org,
        connectionId: gitlab,
        gitlabProjectId: r.id,
        name: g.path,
        defaultBranch: "main",
        types: [],
      }),
    );
    expect(taken.created).toBe(true);

    const listed = await call("alice", "GET", `${found()}?limit=100&search=${r.name}`);
    expect(listed.json.items[0]).toMatchObject({ gitlabProjectId: r.id, projectId: null });
    const done = await run([r.id]);
    expect(done.json.results[0]).toMatchObject({ outcome: "created" });
    expect(done.json.results[0].project.id).not.toBe(taken.project.id);
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, r.id)),
    ).toHaveLength(2);
  });

  test("one GitHub does not have fails alone, in words that say GitHub", async () => {
    const r = repo({ "bun.lock": "" });
    const res = await run([r.id, 2_000_000_000]);
    expect(res.status).toBe(200);
    expect(res.json.results.map((x: { outcome: string }) => x.outcome)).toEqual([
      "created",
      "failed",
    ]);
    expect(res.json.results[1]).toMatchObject({
      reason: "not_found",
      message: "GitHub has no such project, or the token cannot see it.",
    });
  });

  test("one GitHub refuses the token for fails alone, in words that say GitHub", async () => {
    const r = repo({ "bun.lock": "" });
    hub.inject({ method: "GET", path: `/repositories/${r.id}`, status: 403, times: 1 });
    const res = await run([r.id]);
    expect(res.json.results[0]).toMatchObject({
      outcome: "failed",
      reason: "forbidden",
      message: "GitHub refused the token for this project.",
    });
  });

  test("a failure of GitHub itself fails the whole import with fixed words and writes nothing", async () => {
    const [a, b] = [repo({ "bun.lock": "" }), repo({ Dockerfile: "" })];
    const events = (await t.db.select().from(auditEvents)).length;
    hub.inject({ method: "GET", path: `/repositories/${b.id}`, status: 401, times: 1 });
    const res = await run([a.id, b.id]);
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.json.detail).toBe("GitHub rejected the token: it is wrong, expired or revoked.");
    expect(
      await t.db.select().from(projects).where(eq(projects.gitlabProjectId, a.id)),
    ).toHaveLength(0);
    expect((await t.db.select().from(auditEvents)).length).toBe(events);

    // the import retries once, so a GitHub that fails twice is a failure and one that fails once is not
    hub.inject({ method: "GET", path: `/repositories/${a.id}`, status: 500, times: 1 });
    expect((await run([a.id])).status).toBe(200);
    hub.inject({ method: "GET", path: `/repositories/${a.id}`, status: 500, times: 2 });
    expect((await run([a.id])).status).toBe(502);

    hub.inject({ method: "GET", path: "/user/repos", status: 401, times: 1 });
    const listed = await call("alice", "GET", found());
    expect([listed.status, listed.json.detail]).toEqual([
      502,
      "GitHub rejected the token: it is wrong, expired or revoked.",
    ]);
  });

  test("the token is not in any answer, and only an admin may use the routes", async () => {
    const r = repo({ "bun.lock": "" });
    const answers = [
      await call("alice", "GET", found()),
      await run([r.id]),
      await run([2_000_000_000]),
    ];
    for (const a of answers) expect(a.text).not.toContain(TOKEN);
    expect((await call("bob", "GET", found())).status).toBe(403);
    expect(
      (await call("bob", "POST", `${base(github)}/imports`, { gitlabProjectIds: [r.id] })).status,
    ).toBe(403);
  });
});
