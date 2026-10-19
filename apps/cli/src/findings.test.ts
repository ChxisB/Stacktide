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
  secretFindings,
  upsertFindings,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { runCli } from "./cli";
import { findingsCommands } from "./findings";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let mock: MockGitlab;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
const ids = {} as Record<"org" | "web" | "empty", string>;
const tokens = {} as Record<"maintainer" | "reporter", string>;
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
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  for (const name of ["web", "empty"] as const) {
    ids[name] = (
      await createProject(t.db, {
        organizationId: ids.org,
        name,
        gitlabProjectId: mock.addProject({ path: `acme/${name}` }).id,
      })
    ).id;
  }
  await createConnection(t.db, keys, {
    organizationId: ids.org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  let gitlabId = 860;
  for (const name of ["maintainer", "reporter"] as const) {
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
  const projectRoles = (role: "maintainer" | "reporter") =>
    ({ [ids.web]: role, [ids.empty]: role }) as Record<string, "maintainer" | "reporter">;
  roleTable.set(861, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: projectRoles("maintainer"),
  });
  roleTable.set(862, { orgRoles: { [ids.org]: "viewer" }, projectRoles: projectRoles("reporter") });
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-findings-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});

async function orch(argv: string[], who: "maintainer" | "reporter" = "maintainer") {
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
    commands: findingsCommands(),
  });
  return { code, out, err, text: out.join("\n") };
}

const web = ["--org", "acme", "--project", "web"];
const finding = (fingerprint: string, over: object = {}) => ({
  fingerprint,
  rule: "aws-access-token",
  path: "src/config.ts",
  line: 7,
  commit: "a1b2c3d4e5f6",
  severity: "critical" as const,
  ...over,
});
const seed = async () => {
  await t.db.delete(secretFindings);
  await upsertFindings(t.db, {
    organizationId: ids.org,
    projectId: ids.web,
    ref: "main",
    findings: [
      finding("f1"),
      finding("f2", { rule: "gitlab-pat", path: "ci/deploy.sh", line: null, severity: "high" }),
    ],
  });
};
const idOf = async (path: string) => {
  const { findings } = JSON.parse((await orch(["--json", "findings", "ls", ...web])).text) as {
    findings: { id: string; path: string }[];
  };
  return findings.find((f) => f.path === path)?.id ?? "";
};

describe("orch findings ls", () => {
  test("shows where each one is, and says to revoke at the source; a reporter may read", async () => {
    await seed();
    const r = await orch(["findings", "ls", ...web], "reporter");
    expect(r.code).toBe(0);
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^[0-9a-f-]{36} {2}open {2}critical {2}aws-access-token {2}src\/config\.ts:7 {2}main$/,
    );
    expect(lines[1]).toMatch(
      /^[0-9a-f-]{36} {2}open {2}high {2}gitlab-pat {2}ci\/deploy\.sh {2}main$/,
    );
    // the stdout is the list alone; the reminder is for the person
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain("revoke");
    expect(r.err[0]).toContain("source");
  });

  test("a path or branch name cannot send the terminal a control sequence", async () => {
    await t.db.delete(secretFindings);
    await upsertFindings(t.db, {
      organizationId: ids.org,
      projectId: ids.web,
      ref: "feat/\u009b2J\u202ex",
      findings: [finding("c1", { path: "a\u009b31m\u202eb.ts", line: null })],
    });
    const r = await orch(["findings", "ls", ...web]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("a 31m b.ts");
    expect(r.text).toContain("feat/ 2J x");
    expect(r.text).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
    // the JSON is the data as it is
    expect(
      JSON.parse((await orch(["--json", "findings", "ls", ...web])).text).findings[0].path,
    ).toBe("a\u009b31m\u202eb.ts");
  });

  test("a project with none says so, and no reminder is needed", async () => {
    const r = await orch(["findings", "ls", "--org", "acme", "--project", "empty"]);
    expect(r).toMatchObject({ code: 0, text: "no findings in acme/empty", err: [] });
    const doc = JSON.parse(
      (await orch(["--json", "findings", "ls", "--org", "acme", "--project", "empty"])).text,
    );
    expect(doc).toEqual({ target: "acme/empty", findings: [] });
  });

  test("--status filters; a dismissed one shows who, and why, and a bad status costs no request", async () => {
    await seed();
    const id = await idOf("src/config.ts");
    expect((await orch(["findings", "dismiss", id, ...web, "--reason", "a test key"])).code).toBe(
      0,
    );
    const open = await orch(["findings", "ls", ...web, "--status", "open"]);
    expect(open.text.split("\n")).toHaveLength(1);
    expect(open.text).toContain("gitlab-pat");
    const dismissed = await orch(["findings", "ls", ...web, "--status", "dismissed"]);
    expect(dismissed.text).toMatch(
      / {2}dismissed {2}critical {2}aws-access-token {2}src\/config\.ts:7 {2}main {2}by user:\S+: a test key$/,
    );
    // nothing open is listed: no reminder
    expect(dismissed.err).toEqual([]);
    expect((await orch(["findings", "ls", ...web, "--status", "resolved"])).text).toBe(
      "no findings in acme/web",
    );
    const before = mock.requests.length;
    const bad = await orch(["findings", "ls", ...web, "--status", "gone"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toEqual([]);
    expect(mock.requests.length).toBe(before);
  });

  test("--json is the target and the findings, with nothing else", async () => {
    await seed();
    const r = await orch(["--json", "findings", "ls", ...web]);
    const doc = JSON.parse(r.text);
    expect(doc.target).toBe("acme/web");
    expect(doc.findings).toHaveLength(2);
    expect(Object.keys(doc.findings[0]).sort()).toEqual([
      "commit",
      "createdAt",
      "dismissedAt",
      "dismissedBy",
      "dismissedReason",
      "firstSeenAt",
      "id",
      "lastSeenAt",
      "line",
      "organizationId",
      "path",
      "projectId",
      "ref",
      "rule",
      "severity",
      "status",
    ]);
    expect(r.err).toEqual([]);
  });
});

describe("orch findings dismiss and reopen", () => {
  test("dismiss needs a reason, records it, and says that the secret is not made safe", async () => {
    await seed();
    const id = await idOf("src/config.ts");
    const r = await orch(["findings", "dismiss", id, ...web, "--reason", "  an example key  "]);
    expect(r).toMatchObject({ code: 0, text: `dismissed finding ${id} in acme/web` });
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain("does not revoke");
    const doc = JSON.parse(
      (await orch(["--json", "findings", "ls", ...web, "--status", "dismissed"])).text,
    );
    expect(doc.findings[0]).toMatchObject({
      id,
      status: "dismissed",
      dismissedReason: "an example key",
    });
  });

  test("reopen puts it back; either twice is the API's 409 with its code", async () => {
    await seed();
    const id = await idOf("src/config.ts");
    await orch(["findings", "dismiss", id, ...web, "--reason", "x"]);
    const again = await orch(["findings", "dismiss", id, ...web, "--reason", "y"]);
    expect(again.code).toBe(1);
    expect(again.err.join("\n")).toContain("finding_not_open");
    const r = await orch(["findings", "reopen", id, ...web]);
    expect(r).toMatchObject({ code: 0, text: `reopened finding ${id} in acme/web`, err: [] });
    expect(
      (await orch(["findings", "ls", ...web, "--status", "open"])).text.split("\n"),
    ).toHaveLength(2);
    const twice = await orch(["findings", "reopen", id, ...web]);
    expect(twice.code).toBe(1);
    expect(twice.err.join("\n")).toContain("finding_not_dismissed");
  });

  test("a reporter may read but not triage; no such finding is an error", async () => {
    await seed();
    const id = await idOf("src/config.ts");
    const denied = await orch(["findings", "dismiss", id, ...web, "--reason", "x"], "reporter");
    expect(denied.code).toBe(1);
    expect(denied.out).toEqual([]);
    expect(denied.err).toEqual(["error: Not allowed: finding.dismiss (forbidden)"]);
    expect((await orch(["findings", "reopen", crypto.randomUUID(), ...web])).code).toBe(1);
  });

  test("a mistake in the arguments costs no request", async () => {
    const before = mock.requests.length;
    const usage = [
      ["findings"],
      ["findings", "frob"],
      ["findings", "dismiss", ...web], // no id
      ["findings", "dismiss", "some-id", ...web], // no reason
      ["findings", "dismiss", "some-id", ...web, "--reason", "   "],
      ["findings", "reopen", ...web], // no id
      ["findings", "reopen", "some-id", ...web, "--reason", "x"],
      ["findings", "ls", "some-id", ...web],
      ["findings", "ls", ...web, "--reason", "x"],
      ["findings", "dismiss", "some-id", ...web, "--reason", "x", "--status", "open"],
    ];
    for (const argv of usage) {
      const r = await orch(argv);
      expect([argv, r.code]).toEqual([argv, 2]);
      expect(r.out).toEqual([]);
    }
    expect(mock.requests.length).toBe(before);
  });

  test("a reason with terminal control characters cannot reach the terminal", async () => {
    await seed();
    const id = await idOf("src/config.ts");
    await orch(["findings", "dismiss", id, ...web, "--reason", "ok\u001b[2J\u0007 done"]);
    const r = await orch(["findings", "ls", ...web, "--status", "dismissed"]);
    expect(r.text).toContain("ok [2J  done");
    expect(r.text).not.toContain("\u001b");
    expect(r.text).not.toContain("\u0007");
  });
});
