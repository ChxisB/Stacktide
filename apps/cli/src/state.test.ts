import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, parseStateResources, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createConnection,
  createOrganization,
  createProject,
  putState,
  stateVersions,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { runCli } from "./cli";
import { stateCommands } from "./state";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
const CANARY = "CLI-STATE-CANARY-3b8e-do-not-print";

let t: TestDb;
let mock: MockGitlab;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let scope: { organizationId: string; projectId: string };
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

const STACKS = Array.from({ length: 24 }, (_, i) => `s${i}`);
let used = 0;
const fresh = () => {
  const name = STACKS[used++];
  if (!name) throw new Error("out of stacks");
  return name;
};

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  const org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  const web = await createProject(t.db, {
    organizationId: org,
    name: "web",
    gitlabProjectId: mock.addProject({ path: "acme/web" }).id,
  });
  scope = { organizationId: org, projectId: web.id };
  await syncStacks(
    t.db,
    org,
    web.id,
    STACKS.map((name) => ({
      name,
      path: name,
      tool: "tofu" as const,
      version: null,
      tags: [],
      dependsOn: [],
      watch: [],
      applyOn: "command" as const,
      backend: "http" as const,
    })),
    { prune: true },
  );
  await createConnection(t.db, keys, {
    organizationId: org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  let gitlabId = 870;
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
  dir = await mkdtemp(join(tmpdir(), "orch-state-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});

let asked: string[] = [];
beforeEach(() => {
  asked = [];
});

async function orch(
  argv: string[],
  o: { who?: "admin" | "viewer"; yes?: boolean; no?: boolean } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: {
      ORCH_CONFIG: join(dir, "no-config.json"),
      ORCH_API_URL: api,
      ORCH_TOKEN: tokens[o.who ?? "admin"],
    },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async (question) => {
      asked.push(question);
      return !o.no;
    },
    version: "0.0.0",
    commands: stateCommands(),
  });
  return { code, out, err, text: out.join("\n"), all: [...out, ...err].join("\n") };
}
const web = ["--org", "acme", "--project", "web"];
const gitlabState = (serial = 41) =>
  JSON.stringify({
    version: 4,
    terraform_version: "1.9.0",
    serial,
    lineage: "lineage-from-gitlab",
    outputs: { password: { value: CANARY, type: "string", sensitive: true } },
    resources: [
      {
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ schema_version: 0, attributes: { id: "db-1", password: CANARY } }],
      },
    ],
  });
const kept = async () => (await t.db.select().from(stateVersions)).map((v) => v.stackName);
const asksGitLab = () => mock.requests.filter((r) => r.path.includes("/terraform/state/"));

describe("orch state import", () => {
  test("asks first, says what it kept and that it is a copy, and never prints what is in the state", async () => {
    const name = fresh();
    mock.addTerraformState("acme/web", name, gitlabState());
    const r = await orch(["state", "import", name, ...web]);
    expect(r.code).toBe(0);
    expect(r.text).toBe(
      `imported ${name} in acme/web: serial 41, 1 resource, ${Buffer.byteLength(gitlabState())} bytes`,
    );
    // a copy of a moving state: what to do next is said on stderr
    const note = r.err.join(" ");
    expect(note).toContain("copy");
    expect(note).toContain("GitLab");
    expect(note).toContain("merge request");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(name);
    expect(asked[0]).toContain("acme/web");
    expect(await kept()).toContain(name);
    expect(r.all).not.toContain(CANARY);
  });

  test("--yes does not ask; --json is the answer and no note", async () => {
    const name = fresh();
    mock.addTerraformState("acme/web", name, gitlabState(5));
    const r = await orch(["--json", "state", "import", name, "--yes", ...web]);
    expect(r.code).toBe(0);
    expect(asked).toEqual([]);
    expect(JSON.parse(r.text)).toEqual({
      project: "acme/web",
      stack: name,
      serial: 5,
      lineage: "lineage-from-gitlab",
      sizeBytes: Buffer.byteLength(gitlabState(5)),
      resources: 1,
    });
    expect(r.err).toEqual([]);
    expect(r.all).not.toContain(CANARY);
  });

  test("a no costs GitLab nothing and keeps nothing", async () => {
    const name = fresh();
    mock.addTerraformState("acme/web", name, gitlabState());
    const before = asksGitLab().length;
    const r = await orch(["state", "import", name, ...web], { no: true });
    expect(r.code).toBe(1);
    expect(r.all).toContain("cancelled; nothing was changed");
    expect(asksGitLab().length).toBe(before);
    expect(await kept()).not.toContain(name);
  });

  test("a mistake in the words costs no request", async () => {
    const before = mock.requests.length;
    for (const argv of [
      ["state"],
      ["state", "import", ...web],
      ["state", "import", "a", "b", ...web],
      ["state", "wipe", "a", ...web],
      ["state", "import", "a", "--status", ...web],
    ]) {
      expect([argv, (await orch(argv)).code]).toEqual([argv, 2]);
    }
    expect(mock.requests.length).toBe(before);
    expect(asked).toEqual([]);
  });

  test("what the API refuses is said as it said it: a stack that has state, GitLab with none, a viewer", async () => {
    const name = fresh();
    mock.addTerraformState("acme/web", name, gitlabState());
    expect((await orch(["state", "import", name, "--yes", ...web])).code).toBe(0);
    const again = await orch(["state", "import", name, "--yes", ...web]);
    expect(again.code).toBe(1);
    expect(again.out).toEqual([]);
    expect(again.err.join(" ")).toContain("already has state");

    const none = await orch(["state", "import", fresh(), "--yes", ...web]);
    expect(none.code).toBe(1);
    expect(none.err.join(" ")).toContain("GitLab holds no state");

    const other = fresh();
    mock.addTerraformState("acme/web", other, gitlabState());
    const viewer = await orch(["state", "import", other, "--yes", ...web], { who: "viewer" });
    expect(viewer.code).toBe(1);
    expect(await kept()).not.toContain(other);
  });
});

// ---- what the platform holds, read by a person (STATE-10): versions and resource names, never the state

const aws = 'provider["registry.terraform.io/hashicorp/aws"]';
const google = 'provider["registry.terraform.io/hashicorp/google"]';
const res = (type: string, name: string, over: Record<string, unknown> = {}) => ({
  mode: "managed",
  type,
  name,
  provider: aws,
  instances: [{ schema_version: 0, attributes: { id: "x", password: CANARY } }],
  ...over,
});
/** Gives the stack a version for each serial, written the way a job would, the last one holding `resources`. */
async function seed(stackName: string, serials: number[], resources: unknown[] = []) {
  for (const serial of serials) {
    const content = JSON.stringify({
      version: 4,
      serial,
      lineage: "L-cli",
      outputs: { password: { value: CANARY } },
      resources,
    });
    const parsed = parseStateResources(JSON.parse(content));
    if (!parsed.ok) throw new Error("a fixture that is not state");
    const put = await putState(
      t.db,
      keys,
      { ...scope, stackName },
      {
        serial,
        lineage: "L-cli",
        content,
        createdBy: `ci:job-${serial}`,
        resources: parsed.resources,
      },
    );
    if (!put.ok) throw new Error(`fixture refused: ${put.reason}`);
  }
}

describe("orch state ls", () => {
  test("lists the versions newest first: serial, when, size and who; never what the state holds", async () => {
    const name = fresh();
    await seed(name, [1, 2, 3], [res("aws_vpc", "main")]);
    const r = await orch(["state", "ls", name, ...web]);
    expect(r.code).toBe(0);
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split(/\s+/)[1])).toEqual(["3", "2", "1"]);
    expect(lines[0]).toMatch(/^serial 3 {2}\d{4}-\d\d-\d\dT[\d:.]+Z {2}\d+ bytes {2}ci:job-3$/);
    expect(r.all).not.toContain(CANARY);
    expect(r.err).toEqual([]);
  });

  test("--json is the versions with their lineage", async () => {
    const name = fresh();
    await seed(name, [4, 5]);
    const r = await orch(["--json", "state", "ls", name, ...web]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.text) as {
      project: string;
      stack: string;
      versions: { serial: number; lineage: string; createdBy: string }[];
    };
    expect([doc.project, doc.stack]).toEqual(["acme/web", name]);
    expect(doc.versions.map((v) => [v.serial, v.lineage, v.createdBy])).toEqual([
      [5, "L-cli", "ci:job-5"],
      [4, "L-cli", "ci:job-4"],
    ]);
    expect(r.all).not.toContain(CANARY);
  });

  test("a stack with no state says so", async () => {
    const name = fresh();
    const r = await orch(["state", "ls", name, ...web]);
    expect(r.code).toBe(0);
    expect(r.text).toBe(`no state for ${name} in acme/web`);
    const j = await orch(["--json", "state", "ls", name, ...web]);
    expect(JSON.parse(j.text)).toEqual({ project: "acme/web", stack: name, versions: [] });
  });

  test("an organization viewer reads them too: listing is a reporter's, and the state itself is a job's", async () => {
    const name = fresh();
    await seed(name, [1]);
    const r = await orch(["state", "ls", name, ...web], { who: "viewer" });
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("serial 1");
    expect(r.all).not.toContain(CANARY);
  });
});

describe("orch state resources", () => {
  test("lists the names of what the state holds, one address a line, and nothing else of it", async () => {
    const name = fresh();
    await seed(name, [1], [res("aws_vpc", "main"), res("aws_subnet", "a")]);
    const r = await orch(["state", "resources", name, ...web]);
    expect(r.code).toBe(0);
    expect(r.text.split("\n")).toEqual(["aws_subnet.a", "aws_vpc.main"]);
    expect(r.all).not.toContain(CANARY);
  });

  test("filters by type, provider and module, as the API does: exact, and `--module=` is the root", async () => {
    const name = fresh();
    await seed(
      name,
      [1],
      [
        res("aws_vpc", "main"),
        res("aws_vpc", "peer", { module: "module.net" }),
        res("google_dns_zone", "g", { provider: google }),
      ],
    );
    const only = async (...f: string[]) =>
      (await orch(["state", "resources", name, ...f, ...web])).text.split("\n");
    expect(await only("--type", "aws_vpc")).toEqual(["aws_vpc.main", "module.net.aws_vpc.peer"]);
    expect(await only("--provider", "registry.terraform.io/hashicorp/google")).toEqual([
      "google_dns_zone.g",
    ]);
    expect(await only("--module", "module.net")).toEqual(["module.net.aws_vpc.peer"]);
    expect(await only("--module=")).toEqual(["aws_vpc.main", "google_dns_zone.g"]);
    expect(await only("--type", "aws_%")).toEqual([`no resources in ${name} in acme/web`]);
  });

  test("lists past one page, and --json is the whole objects", async () => {
    const name = fresh();
    const many = Array.from({ length: 130 }, (_, i) =>
      res("aws_vpc", `v${String(i).padStart(3, "0")}`),
    );
    await seed(name, [1], many);
    const r = await orch(["state", "resources", name, ...web]);
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(130);
    expect(lines[129]).toBe("aws_vpc.v129");
    const j = await orch(["--json", "state", "resources", name, "--type", "aws_vpc", ...web]);
    const doc = JSON.parse(j.text) as { resources: Record<string, unknown>[] };
    expect(doc.resources).toHaveLength(130);
    expect(doc.resources[0]).toEqual({
      address: "aws_vpc.v000",
      mode: "managed",
      type: "aws_vpc",
      name: "v000",
      provider: "registry.terraform.io/hashicorp/aws",
      module: null,
      indexKey: null,
    });
  });

  test("a name a job chose cannot move the cursor or colour the terminal", async () => {
    const name = fresh();
    await seed(name, [1], [res("aws_vpc", "x\u001b[31mred\u0007")]);
    const r = await orch(["state", "resources", name, ...web]);
    expect(r.text).toBe("aws_vpc.x [31mred "); // each control character became a space
    expect(r.out.join("")).not.toMatch(/\p{Cc}/u);
  });

  test("a stack with no resources says so", async () => {
    const name = fresh();
    expect((await orch(["state", "resources", name, ...web])).text).toBe(
      `no resources in ${name} in acme/web`,
    );
    await seed(name, [1], []);
    expect((await orch(["state", "resources", name, ...web])).text).toBe(
      `no resources in ${name} in acme/web`,
    );
  });
});

describe("orch state, used wrongly", () => {
  test("a flag that belongs to another step, a missing stack or an extra word costs no request", async () => {
    const before = mock.requests.length;
    for (const argv of [
      ["state", "ls", ...web],
      ["state", "ls", "a", "b", ...web],
      ["state", "ls", "a", "--type", "aws_vpc", ...web],
      ["state", "ls", "a", "--yes", ...web],
      ["state", "resources", ...web],
      ["state", "resources", "a", "--yes", ...web],
      ["state", "resources", "a", "--connection", "c", ...web],
      ["state", "import", "a", "--type", "aws_vpc", ...web],
      ["state", "import", "a", "--module", "m", ...web],
    ]) {
      expect([argv, (await orch(argv)).code]).toEqual([argv, 2]);
    }
    expect(mock.requests.length).toBe(before);
    expect(asked).toEqual([]);
  });
});
