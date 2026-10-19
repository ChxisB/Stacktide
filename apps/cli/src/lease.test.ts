import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  secretLeases,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { runCli } from "./cli";
import { leaseCommands } from "./lease";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let mock: MockGitlab;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
const ids = {} as Record<"org" | "web", string>;
const tokens = {} as Record<"developer" | "reporter", string>;
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

/** Everything a command printed except the one line `issue` prints on purpose: the token. */
const quiet: string[] = [];
const issued: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  ids.web = (
    await createProject(t.db, {
      organizationId: ids.org,
      name: "web",
      gitlabProjectId: mock.addProject({ path: "acme/web" }).id,
    })
  ).id;
  await createConnection(t.db, keys, {
    organizationId: ids.org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  let gitlabId = 840;
  for (const name of ["developer", "reporter"] as const) {
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
  }
  roleTable.set(841, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.web]: "developer" },
  });
  roleTable.set(842, {
    orgRoles: { [ids.org]: "viewer" }, // a member of the organization would be a developer
    projectRoles: { [ids.web]: "reporter" },
  });
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-lease-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  expect(issued.length).toBeGreaterThan(0);
  for (const value of issued) expect(quiet.join("\n")).not.toContain(value);
});

async function orch(argv: string[], who: "developer" | "reporter" = "developer") {
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
    commands: leaseCommands(),
  });
  quiet.push(...err, ...(argv.includes("issue") ? [] : out));
  return { code, out, err, text: out.join("\n") };
}

const web = ["--org", "acme", "--project", "web"];
const issue = (...extra: string[]) => orch(["lease", "issue", ...web, ...extra]);

describe("orch lease issue", () => {
  test("prints the token alone on stdout and the rest on stderr, and the token works at GitLab", async () => {
    const r = await issue("--scopes", "read_repository,read_api", "--ttl", "600");
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const [value] = r.out;
    expect(value).toMatch(/^glpat-\S+$/);
    issued.push(value ?? "");
    expect(mock.accessTokenValid(value ?? "")).toBe(true);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(
      /^lease \S+ for acme\/web: read_repository, read_api, ends \d{4}-\d\d-\d\dT/,
    );
    expect(r.err[0]).not.toContain(value ?? "");
    const ends = Date.parse(r.err[0]?.match(/ends (\S+)/)?.[1] ?? "");
    expect(ends - Date.now()).toBeGreaterThan(590_000);
    expect(ends - Date.now()).toBeLessThan(610_000);
  });

  test("--json is one document with the target, the lease and the token", async () => {
    const r = await orch(["--json", "lease", "issue", ...web, "--scopes", "read_registry"]);
    const doc = JSON.parse(r.text);
    issued.push(doc.value);
    expect(doc).toMatchObject({
      target: "acme/web",
      provider: "gitlab-token",
      scopes: ["read_registry"],
      revokedAt: null,
    });
    expect(doc.value).toMatch(/^glpat-/);
    expect(Object.keys(doc)).not.toContain("handle");
    expect(r.err).toEqual([]);
  });

  test("a mistake in the arguments costs no request and prints no token", async () => {
    const before = mock.requests.length;
    const usage = [
      ["lease"],
      ["lease", "frob"],
      ["lease", "issue", ...web], // no scopes
      ["lease", "issue", ...web, "--scopes", "read_api", "--ttl", "ten"],
      ["lease", "issue", ...web, "--scopes", "read_api", "--ttl", "1.5"],
      ["lease", "issue", ...web, "--scopes", "read_api", "--ttl", "0"],
      ["lease", "issue", "extra", ...web, "--scopes", "read_api"],
      ["lease", "list", ...web, "--scopes", "read_api"],
      ["lease", "list", ...web, "--ttl", "60"],
      ["lease", "revoke", ...web], // no id
      ["lease", "list", "some-id", ...web],
    ];
    for (const argv of usage) {
      const r = await orch(argv);
      expect([argv, r.code]).toEqual([argv, 2]);
      expect(r.out).toEqual([]);
    }
    expect(mock.requests.length).toBe(before);
  });

  test("what the API refuses is said with its code, and nothing is printed to stdout", async () => {
    for (const args of [
      ["--scopes", "api"],
      ["--scopes", "read_api", "--ttl", "5"],
    ]) {
      const r = await issue(...args);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toEqual(["error: Request validation failed (validation_failed)"]);
    }
    const denied = await orch(["lease", "issue", ...web, "--scopes", "read_api"], "reporter");
    expect(denied.code).toBe(1);
    expect(denied.out).toEqual([]);
    expect(denied.err).toEqual(["error: Not allowed: lease.issue (forbidden)"]);
  });
});

describe("orch lease list and revoke", () => {
  test("list shows who holds what and when it ends, and never a token; a reporter may read it", async () => {
    await t.db.delete(secretLeases);
    expect((await orch(["lease", "list", ...web])).text).toBe("no leases in acme/web");
    const made = await orch(["--json", "lease", "issue", ...web, "--scopes", "read_repository"]);
    const { id, value } = JSON.parse(made.text);
    issued.push(value);

    const list = await orch(["lease", "list", ...web], "reporter");
    expect(list.code).toBe(0);
    expect(list.out).toHaveLength(1);
    expect(list.text).toMatch(new RegExp(`^${id}  user:\\S+  read_repository  ends \\d{4}-`));
    expect(list.text).not.toContain(value);

    const doc = JSON.parse((await orch(["--json", "lease", "list", ...web])).text);
    expect(doc.target).toBe("acme/web");
    expect(doc.leases).toHaveLength(1);
    expect(doc.leases[0].id).toBe(id);
    expect(JSON.stringify(doc)).not.toContain(value);
  });

  test("revoke ends the token at GitLab; the lease then reads as ended, and a second revoke says so", async () => {
    await t.db.delete(secretLeases);
    const made = await orch(["--json", "lease", "issue", ...web, "--scopes", "read_api"]);
    const { id, value } = JSON.parse(made.text);
    issued.push(value);
    expect(mock.accessTokenValid(value)).toBe(true);

    const r = await orch(["lease", "revoke", id, ...web]);
    expect(r.code).toBe(0);
    expect(r.text).toBe(`revoked lease ${id} in acme/web`);
    expect(mock.accessTokenValid(value)).toBe(false);
    expect((await orch(["lease", "list", ...web])).text).toMatch(/ended \d{4}-/);

    const again = await orch(["lease", "revoke", id, ...web]);
    expect(again.code).toBe(1);
    expect(again.err.join("\n")).toContain("lease_ended");

    const missing = await orch(["lease", "revoke", crypto.randomUUID(), ...web]);
    expect(missing.code).toBe(1);
    const reporter = await orch(["lease", "revoke", id, ...web], "reporter");
    expect(reporter.code).toBe(1);
  });
});
