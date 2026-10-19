import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createCiToken,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  MAX_STATE_BYTES,
  stateLocks,
  stateResources,
  stateVersions,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newCiToken, randomToken } from "./tokens";

// STATE-7: the platform reads a stack's GitLab-managed state once and keeps it as its own first version.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "GITLAB-STATE-CANARY-5d2c1e-do-not-leak";
const REVOKED = "revoked-token-not-the-mocks-0000";
const HOUR = 3_600_000;

let t: TestDb;
let mock: MockGitlab;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<
  "maintainer" | "developer" | "reporter" | "admin" | "other",
  { id: string; cookie: string }
>;
const ids = {} as Record<
  "o1" | "o2" | "p1" | "unlinked" | "p3" | "c1" | "c2" | "cBad" | "cVault",
  string
>;
const make = (withKeys = true) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId ?? 0) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    ...(withKeys && { keys }),
  });
let app: ReturnType<typeof make>;

// Each test takes stacks of its own: an import that succeeds uses its stack up.
const STACKS = Array.from({ length: 40 }, (_, i) => `s${i}`);
let used = 0;
const fresh = () => {
  const name = STACKS[used++];
  if (!name) throw new Error("out of stacks");
  return name;
};
const stack = (name: string) => ({
  name,
  path: name,
  tool: "tofu" as const,
  version: null,
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command" as const,
  backend: "http" as const,
});

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  const remote = mock.addProject({ path: "platform/one" }).id;
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.p1 = (
    await createProject(t.db, { organizationId: ids.o1, name: "p1", gitlabProjectId: remote })
  ).id;
  ids.unlinked = (await createProject(t.db, { organizationId: ids.o1, name: "unlinked" })).id;
  ids.p3 = (
    await createProject(t.db, { organizationId: ids.o2, name: "p3", gitlabProjectId: remote })
  ).id;
  for (const [o, p] of [
    [ids.o1, ids.p1],
    [ids.o1, ids.unlinked],
    [ids.o2, ids.p3],
  ] as const) {
    await syncStacks(t.db, o, p, STACKS.map(stack), { prune: true });
  }
  const connect = async (organizationId: string, type: string, name: string, token: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId,
        type,
        name,
        config: { baseUrl: mock.url },
        token,
      })
    ).id;
  ids.c1 = await connect(ids.o1, "gitlab", "live", mock.token);
  ids.c2 = await connect(ids.o2, "gitlab", "live", mock.token);
  ids.cBad = await connect(ids.o1, "gitlab", "revoked", REVOKED);
  ids.cVault = await connect(ids.o1, "vault", "not-gitlab", "some-vault-secret");
  let gitlabId = 800;
  for (const name of ["maintainer", "developer", "reporter", "admin", "other"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(801, { orgRoles: {}, projectRoles: { [ids.p1]: "maintainer" } });
  roleTable.set(802, { orgRoles: {}, projectRoles: { [ids.p1]: "developer" } });
  roleTable.set(803, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } });
  roleTable.set(804, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} });
  // `other` holds no role anywhere
  app = make();
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const at = (stackName: string, project = ids.p1, org = ids.o1) =>
  `/organizations/${org}/projects/${project}/state/${stackName}`;
const basic = (password: string) => `Basic ${Buffer.from(`ci:${password}`).toString("base64")}`;
const ciToken = async (scopes = ["project.read", "state.read", "state.write"]) => {
  const issued = newCiToken();
  await createCiToken(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    tokenHash: issued.tokenHash,
    scopes,
    gitlabProjectId: 1,
    gitlabJobId: 4242,
    ref: "main",
    refProtected: true,
    ttlMs: HOUR,
  });
  return issued.token;
};

interface Sent {
  authorization?: string;
  cookie?: string;
  body?: unknown;
  app?: typeof app;
}
async function send(method: string, path: string, o: Sent = {}) {
  const headers: Record<string, string> = {};
  if (o.authorization) headers.authorization = o.authorization;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.app ?? app).handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body:
        o.body === undefined
          ? undefined
          : typeof o.body === "string"
            ? o.body
            : JSON.stringify(o.body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: (text && res.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : undefined) as { code?: string; items?: unknown[]; [field: string]: unknown },
  };
}
const importing = (
  stackName: string,
  o: { cookie?: string; connection?: string; project?: string; org?: string; body?: unknown } = {},
) =>
  send("POST", `${at(stackName, o.project, o.org)}/import`, {
    cookie: o.cookie ?? people.maintainer.cookie,
    body: o.body ?? { connectionId: o.connection ?? ids.c1 },
  });

/** What GitLab holds: Terraform state, version 4, with secrets in places the platform must never copy. */
const gitlabState = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 4,
    terraform_version: "1.9.0",
    serial: 41,
    lineage: "lineage-from-gitlab",
    outputs: { password: { value: CANARY, type: "string", sensitive: true } },
    resources: [
      {
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            schema_version: 0,
            attributes: { id: "db-1", password: CANARY },
            sensitive_attributes: [[{ type: "get_attr", value: CANARY }]],
            private: CANARY,
          },
        ],
      },
    ],
    ...over,
  });
const versionsOf = (stackName: string, project = ids.p1) =>
  t.db
    .select()
    .from(stateVersions)
    .where(and(eq(stateVersions.projectId, project), eq(stateVersions.stackName, stackName)));
const imports = (stackName: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "state.import"), eq(auditEvents.resourceId, stackName)));
/** After a refusal: no version, no index row, no audit event. */
const nothingKept = async (stackName: string, project = ids.p1) => {
  expect(await versionsOf(stackName, project)).toEqual([]);
  expect(await imports(stackName)).toEqual([]);
  expect(
    await t.db
      .select()
      .from(stateResources)
      .where(and(eq(stateResources.projectId, project), eq(stateResources.stackName, stackName))),
  ).toEqual([]);
};

describe("importing a stack's GitLab-managed state", () => {
  test("keeps it as the first version here, at its own serial and lineage, byte for byte", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    const done = await importing(name);
    expect(done.status).toBe(201);
    expect(done.json).toEqual({
      serial: 41,
      lineage: "lineage-from-gitlab",
      sizeBytes: Buffer.byteLength(gitlabState()),
      resources: 1,
    });
    // a job reads back exactly what GitLab held
    const as = { authorization: basic(await ciToken()) };
    const read = await send("GET", at(name), as);
    expect(read.status).toBe(200);
    expect(read.text).toBe(gitlabState());
    const [version, ...more] = await versionsOf(name);
    expect(more).toEqual([]);
    expect(version).toMatchObject({ serial: 41, lineage: "lineage-from-gitlab" });
    expect(version?.createdBy).toBe(`import:user:${people.maintainer.id}`);
    // the index was written with it: names only
    const index = await send("GET", `${at(name)}/resources`, { cookie: people.maintainer.cookie });
    expect(index.json.items).toEqual([
      {
        address: "aws_db_instance.main",
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider: "registry.terraform.io/hashicorp/aws",
        module: null,
        indexKey: null,
      },
    ]);
    // the stack carries on from the imported serial, in its lineage only
    const write = (serial: number, lineage: string) =>
      send("POST", at(name), { ...as, body: gitlabState({ serial, lineage }) });
    expect((await write(42, "lineage-from-gitlab")).status).toBe(200);
    expect((await write(43, "someone-elses")).status).toBe(409);
  });

  test("is audited with who, the stack and the size, and nothing of what is in it", async () => {
    const name = fresh();
    const text = gitlabState({ serial: 7 });
    mock.addTerraformState("platform/one", name, text);
    const done = await importing(name);
    expect(done.status).toBe(201);
    const [event, ...more] = await imports(name);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      resourceType: "state",
      organizationId: ids.o1,
      projectId: ids.p1,
    });
    expect(event?.metadata).toEqual({
      stack: name,
      serial: 7,
      sizeBytes: Buffer.byteLength(text),
      resources: 1,
    });
    // the canary is in GitLab's state and in what a job reads back; in none of what else is kept or said
    for (const kept of [
      await t.db.select().from(auditEvents),
      await t.db.select().from(stateResources),
      lines,
      done.text,
    ]) {
      expect(JSON.stringify(kept)).not.toContain(CANARY);
    }
  });

  test("a stack that has state refuses it, and GitLab is not even asked", async () => {
    const name = fresh();
    const as = { authorization: basic(await ciToken()) };
    expect((await send("POST", at(name), { ...as, body: gitlabState({ serial: 3 }) })).status).toBe(
      200,
    );
    // GitLab's copy is not even state: the refusal is the stack's, so it was never read
    mock.addTerraformState("platform/one", name, "not state");
    const refused = await importing(name);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("not_empty");
    // and a valid one does not replace it either
    mock.addTerraformState("platform/one", name, gitlabState({ serial: 99 }));
    expect((await importing(name)).status).toBe(409);
    expect((await versionsOf(name)).map((v) => v.serial)).toEqual([3]);
    expect(await imports(name)).toEqual([]);
  });

  test("two imports at once keep exactly one", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState({ serial: 5 }));
    const answers = await Promise.all([importing(name), importing(name), importing(name)]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409]);
    expect(await versionsOf(name)).toHaveLength(1);
    expect(await imports(name)).toHaveLength(1);
  });
});

describe("what GitLab holds, and what it does not", () => {
  test("no state of this name is a 404 and writes nothing", async () => {
    const name = fresh();
    const none = await importing(name);
    expect(none.status).toBe(404);
    expect(none.json.code).toBe("state_not_found");
    await nothingKept(name);
  });

  test("a state that is not Terraform state (version 4) is refused whole, and its text is not echoed", async () => {
    const name = fresh();
    const bad = [
      `not json ${CANARY}`,
      JSON.stringify([CANARY]),
      gitlabState({ version: 3 }),
      gitlabState({ serial: 1.5 }),
      gitlabState({ serial: -1 }),
      gitlabState({ serial: 2 ** 31 }),
      gitlabState({ lineage: "" }),
      gitlabState({ lineage: "x".repeat(257) }),
      gitlabState({ resources: { [CANARY]: 1 } }),
      gitlabState({
        resources: [{ mode: CANARY, type: "a", name: "b", provider: "c", instances: [] }],
      }),
    ];
    for (const text of bad) {
      mock.addTerraformState("platform/one", name, text);
      const r = await importing(name);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("invalid_state");
      expect(r.text).not.toContain(CANARY);
    }
    await nothingKept(name);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  test("a state larger than the repository stores is refused, and nothing is kept", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, "x".repeat(MAX_STATE_BYTES + 1));
    const r = await importing(name);
    expect(r.status).toBe(413);
    expect(r.json.code).toBe("payload_too_large");
    await nothingKept(name);
  });

  test("GitLab refusing the connection's token is a 502 in fixed words that name no token", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    const r = await importing(name, { connection: ids.cBad });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("gitlab_failed");
    expect(r.json.detail).toBe("GitLab rejected the token: it is wrong, expired or revoked.");
    expect(r.text).not.toContain(REVOKED);
    expect(lines.join("\n")).not.toContain(REVOKED);
    await nothingKept(name);
  });

  test("a project that is not linked to GitLab has nothing to import from", async () => {
    const name = fresh();
    const r = await importing(name, { project: ids.unlinked, cookie: people.admin.cookie });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("project_unlinked");
    await nothingKept(name, ids.unlinked);
  });

  test("a connection of another organization is not found, and one that is not GitLab's is refused", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    expect((await importing(name, { connection: ids.c2 })).status).toBe(404);
    const vault = await importing(name, { connection: ids.cVault });
    expect(vault.status).toBe(422);
    expect(vault.json.code).toBe("connection_type");
    await nothingKept(name);
  });
});

describe("who may import, and what is checked first", () => {
  test("a maintainer or an organization admin does; a developer, a reporter, a job and a stranger do not", async () => {
    const stackOf = new Map<string, string>();
    const name = (who: string) => {
      const s = stackOf.get(who) ?? fresh();
      stackOf.set(who, s);
      mock.addTerraformState("platform/one", s, gitlabState());
      return s;
    };
    const ask = (stackName: string, o: { cookie?: string; authorization?: string }) =>
      send("POST", `${at(stackName)}/import`, { ...o, body: { connectionId: ids.c1 } });
    expect((await ask(name("anon"), {})).status).toBe(401);
    expect((await ask(name("developer"), { cookie: people.developer.cookie })).status).toBe(403);
    expect((await ask(name("reporter"), { cookie: people.reporter.cookie })).status).toBe(403);
    expect((await ask(name("other"), { cookie: people.other.cookie })).status).toBe(404);
    expect((await ask(name("job"), { authorization: `Bearer ${await ciToken()}` })).status).toBe(
      403,
    );
    expect((await ask(name("basic"), { authorization: basic(await ciToken()) })).status).toBe(403);
    for (const refused of ["anon", "developer", "reporter", "other", "job", "basic"]) {
      await nothingKept(name(refused));
    }
    expect((await ask(name("maintainer"), { cookie: people.maintainer.cookie })).status).toBe(201);
    expect((await ask(name("admin"), { cookie: people.admin.cookie })).status).toBe(201);
  });

  test("it needs the master keys", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    const r = await send("POST", `${at(name)}/import`, {
      cookie: people.maintainer.cookie,
      body: { connectionId: ids.c1 },
      app: make(false),
    });
    expect(r.status).toBe(503);
    await nothingKept(name);
  });

  test("the body is exactly { connectionId }", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    for (const body of [
      {},
      { connectionId: "nope" },
      { connectionId: ids.c1, extra: 1 },
      "not json",
    ]) {
      const r = await importing(name, { body });
      expect([400, 422]).toContain(r.status);
    }
    await nothingKept(name);
  });

  test("the stack must be one the repository's scan found", async () => {
    const r = await importing("not-a-stack");
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("unknown_stack");
    await nothingKept("not-a-stack");
  });

  test("a held lock holds an import off, and it works once the lock is gone", async () => {
    const name = fresh();
    mock.addTerraformState("platform/one", name, gitlabState());
    await t.db.insert(stateLocks).values({
      organizationId: ids.o1,
      projectId: ids.p1,
      stackName: name,
      lockId: "L1",
      owner: `ci:${ids.p1}:job-9`,
      info: { ID: "L1" },
      expiresAt: new Date(Date.now() + HOUR),
    });
    const held = await importing(name);
    expect(held.status).toBe(423);
    expect(held.json.code).toBe("state_locked");
    await nothingKept(name);
    await t.db.delete(stateLocks).where(eq(stateLocks.stackName, name));
    expect((await importing(name)).status).toBe(201);
  });
});
