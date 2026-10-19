import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createConnection,
  createOrganization,
  createProject,
  upsertUser,
  workerPools,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { runCli } from "./cli";
import { poolCommands } from "./pool";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let mock: MockGitlab;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let webPath: string;
const tokens = {} as Record<"admin" | "viewer", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    hardening: { rateLimitScale: 100 },
  });

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  const org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  webPath = "acme/web";
  await createProject(t.db, {
    organizationId: org,
    name: "web",
    gitlabProjectId: mock.addProject({ path: webPath }).id,
  });
  await createProject(t.db, { organizationId: org, name: "loose" });
  await createConnection(t.db, keys, {
    organizationId: org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  let gitlabId = 880;
  for (const [name, role] of [
    ["admin", "admin"],
    ["viewer", "viewer"],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: user.id,
      name: "test",
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes: ["*"],
      ttlMs: 3_600_000,
    });
    tokens[name] = fresh.token;
    roleTable.set(gitlabId, { orgRoles: { [org]: role }, projectRoles: {} });
  }
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-pool-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.db.delete(workerPools);
});

async function orch(argv: string[], who: "admin" | "viewer" = "admin") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: api, ORCH_TOKEN: tokens[who] },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async () => true,
    version: "0.0.0",
    commands: poolCommands(),
  });
  return { code, out, err, text: out.join("\n") };
}
const acme = ["--org", "acme"];
const web = [...acme, "--project", "web"];
const add = (name: string, ...more: string[]) =>
  orch(["pool", "add", name, "--tag", "prod-runners", ...more, ...acme]);
const listed = async () =>
  (
    JSON.parse((await orch(["--json", "pool", "ls", ...acme])).text) as {
      pools: { name: string; isDefault: boolean }[];
    }
  ).pools;

describe("orch pool ls", () => {
  test("an organization with none says so; --json is the organization and an empty list", async () => {
    expect(await orch(["pool", "ls", ...acme])).toMatchObject({
      code: 0,
      text: "no pools in acme",
      err: [],
    });
    expect(JSON.parse((await orch(["--json", "pool", "ls", ...acme])).text)).toEqual({
      org: "acme",
      pools: [],
    });
  });

  test("one line each: name, tags, image, enabled or not, and the default; a viewer may read", async () => {
    await add("plain");
    await add("custom", "--tag", "gpu", "--image", "registry.example.com/iac:1", "--default");
    await add("parked", "--disabled");
    const r = await orch(["pool", "ls", ...acme], "viewer");
    expect(r.code).toBe(0);
    expect(r.text.split("\n")).toEqual([
      "plain  tags prod-runners  image -  enabled",
      "custom  tags prod-runners,gpu  image registry.example.com/iac:1  enabled  default",
      "parked  tags prod-runners  image -  disabled",
    ]);
  });
});

describe("orch pool add, default and rm", () => {
  test("add says what it made and, on stderr, that tags route and do not isolate", async () => {
    const r = await add("prod", "--image", "registry.example.com/iac:1");
    expect(r.code).toBe(0);
    expect(r.text).toBe("added pool prod in acme (tags prod-runners)");
    expect(r.err.join(" ")).toContain("routing");
    expect(r.err.join(" ")).toContain("isolat");
    expect(await listed()).toMatchObject([{ name: "prod", isDefault: false }]);
    // for a script the answer is the pool, and no reminder
    const json = await orch(["--json", "pool", "add", "second", "--tag", "x", ...acme]);
    expect(JSON.parse(json.text).pool).toMatchObject({ name: "second", tags: ["x"] });
    expect(json.err).toEqual([]);
  });

  test("a mistake in the words costs no request; one the API refuses is said as it said it", async () => {
    const before = mock.requests.length;
    for (const argv of [
      ["pool"],
      ["pool", "add", "x", ...acme],
      ["pool", "add", "--tag", "a", ...acme],
      ["pool", "rm", ...acme],
      ["pool", "default", ...acme],
      ["pool", "default", "x", "--clear", ...acme],
      ["pool", "ls", "extra", ...acme],
      ["pool", "ls", "--status", ...acme],
    ]) {
      expect([argv, (await orch(argv)).code]).toEqual([argv, 2]);
    }
    expect(mock.requests.length).toBe(before);
    const bad = await orch(["pool", "add", "x", "--tag", "has space", ...acme]);
    expect(bad.code).toBe(1);
    expect(bad.out).toEqual([]);
    expect(bad.err.join(" ")).not.toContain("has space");
    expect(await listed()).toEqual([]);
  });

  test("an empty --image is not dropped: the API refuses it, and no pool is made", async () => {
    const r = await add("blank-image", "--image", "");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(await listed()).toEqual([]);
  });

  test("default moves from one pool to another, --clear leaves none, and the default cannot be removed", async () => {
    await add("one");
    await add("two");
    expect((await orch(["pool", "default", "one", ...acme])).text).toBe(
      "one is the default pool of acme",
    );
    expect((await listed()).filter((p) => p.isDefault).map((p) => p.name)).toEqual(["one"]);
    await orch(["pool", "default", "two", ...acme]);
    expect((await listed()).filter((p) => p.isDefault).map((p) => p.name)).toEqual(["two"]);

    const refused = await orch(["pool", "rm", "two", ...acme]);
    expect(refused.code).toBe(1);
    expect(refused.err.join(" ")).toContain("pool_is_default");

    expect((await orch(["pool", "default", "--clear", ...acme])).text).toBe(
      "acme has no default pool",
    );
    expect((await listed()).some((p) => p.isDefault)).toBe(false);
    // clearing again is not an error
    expect((await orch(["pool", "default", "--clear", ...acme])).code).toBe(0);

    expect((await orch(["pool", "rm", "two", ...acme])).text).toBe("removed pool two from acme");
    expect((await listed()).map((p) => p.name)).toEqual(["one"]);
  });

  test("an unknown name lists the known ones", async () => {
    await add("one");
    const r = await orch(["pool", "rm", "nope", ...acme]);
    expect(r.code).toBe(2);
    expect(r.err.join(" ")).toContain("no pool 'nope'; known: one");
  });

  test("a viewer is refused every change", async () => {
    await add("one");
    for (const argv of [
      ["pool", "add", "x", "--tag", "a", ...acme],
      ["pool", "rm", "one", ...acme],
      ["pool", "default", "one", ...acme],
    ]) {
      expect([argv, (await orch(argv, "viewer")).code]).toEqual([argv, 1]);
    }
    expect((await listed()).map((p) => p.name)).toEqual(["one"]);
  });
});

describe("orch pool ls --status", () => {
  test("healthy, degraded and offline, with the count, for the project asked about", async () => {
    await add("prod");
    mock.addRunner(webPath, { tags: ["prod-runners"] });
    expect((await orch(["pool", "ls", "--status", ...web])).text).toContain(
      "prod  tags prod-runners  image -  enabled  healthy (1 of 1 online)",
    );
    mock.addRunner(webPath, { tags: ["prod-runners"], status: "offline" });
    expect((await orch(["pool", "ls", "--status", ...web])).text).toContain(
      "degraded (1 of 2 online)",
    );
    await t.db.delete(workerPools);
    await orch(["pool", "add", "idle", "--tag", "nobody-has-this", ...acme]);
    expect((await orch(["pool", "ls", "--status", ...web])).text).toContain(
      "offline (0 of 0 online)",
    );
  });

  test("a token GitLab will not let list runners reads unknown, not healthy, and says why", async () => {
    await add("prod");
    mock.addRunner(webPath, { tags: ["prod-runners"] });
    mock.inject({ method: "GET", path: /\/runners$/, status: 403 });
    const r = await orch(["pool", "ls", "--status", ...web]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("unknown (the connection's token cannot list the project's runners)");
    expect(r.text).not.toContain("healthy");
  });

  test("a project that is not on GitLab is unknown, and --json carries the state", async () => {
    await orch(["pool", "add", "prod", "--tag", "tag-no-runner-has", ...acme]);
    const text = (await orch(["pool", "ls", "--status", ...acme, "--project", "loose"])).text;
    expect(text).toContain("unknown (the project is not on GitLab)");
    const doc = JSON.parse((await orch(["--json", "pool", "ls", "--status", ...web])).text);
    expect(doc.pools[0].health).toMatchObject({
      state: "offline",
      online: 0,
      total: 0,
      reason: null,
    });
  });

  test("a viewer cannot ask for the status: it uses the organization's connection", async () => {
    await add("prod");
    const r = await orch(["pool", "ls", "--status", ...web], "viewer");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
  });
});
