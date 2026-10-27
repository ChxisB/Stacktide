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
  auditEvents,
  createApiToken,
  createConnection,
  createOrganization,
  createProject,
  listResources,
  savePipelineConfig,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { runCli } from "./cli";
import { resourceCommands } from "./resource";

// BLP-19: `orch resource` over the real API and the mock GitLab. A resource is a merge request; nothing here
// reaches a cloud.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let mock: MockGitlab;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let org: string;
let projectId: string;
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
  org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  const connection = await createConnection(t.db, keys, {
    organizationId: org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  const repo = mock.addProject({ path: "acme/infra" });
  const project = await createProject(t.db, {
    organizationId: org,
    name: "infra",
    gitlabProjectId: repo.id,
    connectionId: connection.id,
  });
  projectId = project.id;
  await savePipelineConfig(t.db, {
    organizationId: org,
    projectId,
    connectionId: connection.id,
    template: "bun-app",
    version: "1.0.0",
    params: {},
    overrides: {},
    renderedHash: "0".repeat(64),
    mode: "inline",
    includeProject: null,
    includeRef: null,
    mrIid: null,
    mrUrl: null,
  });
  let gitlabId = 910;
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
  dir = await mkdtemp(join(tmpdir(), "orch-resource-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});

async function orch(argv: string[], who: "admin" | "viewer" = "admin") {
  const out: string[] = [];
  const err: string[] = [];
  const asked = mock.requests.length;
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: api, ORCH_TOKEN: tokens[who] },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async () => true,
    version: "0.0.0",
    commands: resourceCommands(),
  });
  return {
    code,
    out,
    err,
    text: out.join("\n"),
    /** The requests that changed something on GitLab. */
    writes: () => mock.requests.slice(asked).filter((r) => r.method !== "GET"),
  };
}
const where = ["--org", "acme", "--project", "infra"];
const bucket = (name: string, ...more: string[]) => [
  "resource",
  "add",
  "bucket",
  "--env",
  "staging",
  "--cloud",
  "gcp",
  "--name",
  name,
  "--region",
  "us-central1",
  "--gcp-project",
  "my-proj-1234",
  ...more,
  ...where,
];
const identityFlags = (...more: string[]) => [
  "resource",
  "add",
  "deploy-identity",
  "--env",
  "staging",
  "--cloud",
  "gcp",
  "--name",
  "main",
  "--region",
  "us-central1",
  ...more,
  ...where,
];
const service = (...more: string[]) => [
  "resource",
  "add",
  "service",
  "--env",
  "staging",
  "--cloud",
  "gcp",
  "--name",
  "api",
  "--region",
  "us-central1",
  ...more,
  ...where,
];
const rows = () => listResources(t.db, org, projectId, { limit: 100 });

describe("orch resource blueprints", () => {
  test("the kinds, what each uses, the clouds with their version and idle cost; --json is the catalog", async () => {
    const r = await orch(["resource", "blueprints"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("service  uses network, postgres, bucket");
    expect(r.text).toMatch(/ {2}gcp {2}v1 {2}idle: /);
    const json = JSON.parse((await orch(["--json", "resource", "blueprints"])).text);
    expect(json.kinds.map((k: { kind: string }) => k.kind)).toEqual([
      "network",
      "service",
      "postgres",
      "bucket",
      "deploy-identity",
    ]);
    expect(r.text).toContain("deploy-identity  uses service");
  });
});

describe("orch resource add", () => {
  test("opens one merge request and says so, and that nothing exists in the cloud yet; the row is recorded", async () => {
    const r = await orch(bucket("files"));
    expect(r.code).toBe(0);
    expect(r.text.split("\n")[0]).toMatch(/^staging-files-bucket: opened .*\/merge_requests\/\d+$/);
    expect(r.text).toContain("nothing exists in the cloud until the request is merged");
    expect(r.writes().length).toBeGreaterThan(0);
    expect(await rows()).toMatchObject([{ stack: "staging-files-bucket", cloud: "gcp" }]);
  });

  test("--json is the proposal, the files included", async () => {
    const r = await orch(["--json", ...bucket("data")]);
    const doc = JSON.parse(r.text);
    expect(doc).toMatchObject({
      dryRun: false,
      stack: "staging-data-bucket",
      path: "infra/staging/data-bucket",
      outcome: "opened",
    });
    expect(doc.files).toContain("infra/staging/data-bucket/stack.yml");
  });

  test("a second call changes the same request", async () => {
    await orch(bucket("again"));
    const second = await orch(bucket("again", "--versioning", "true"));
    expect(second.code).toBe(0);
    expect(second.text.split("\n")[0]).toMatch(/^staging-again-bucket: updated /);
  });

  test("--dry-run lists the files and the idle cost, writes nothing and records nothing", async () => {
    const before = (await rows()).length;
    const events = (await t.db.select().from(auditEvents)).length;
    const r = await orch(bucket("dry", "--dry-run"));
    expect(r.code).toBe(0);
    expect(r.writes()).toEqual([]);
    expect(r.text).toContain("dry run: add staging-dry-bucket");
    expect(r.text).toContain("  infra/staging/dry-bucket/main.tf");
    expect(r.text).toContain("idle cost: ");
    expect(r.text.split("\n").at(-1)).toBe("nothing was written");
    expect((await rows()).length).toBe(before);
    expect((await t.db.select().from(auditEvents)).length).toBe(events);
    const json = JSON.parse((await orch(["--json", ...bucket("dry", "--dry-run")])).text);
    expect(json).toMatchObject({ dryRun: true, verb: "add", stack: "staging-dry-bucket" });
  });

  test("a service takes its own flags, and the API's refusal is named by key", async () => {
    const r = await orch([
      "resource",
      "add",
      "service",
      "--env",
      "staging",
      "--cloud",
      "gcp",
      "--name",
      "api",
      "--region",
      "us-central1",
      "--gcp-project",
      "my-proj-1234",
      "--port",
      "3000",
      "--public",
      "true",
      "--uses",
      "postgres:main",
      "--dry-run",
      ...where,
    ]);
    // what the project holds is something only the API can know
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("uses: a service that uses a postgres needs a network");
  });

  test("a deploy identity takes the repository and its ids, and is checked against the service it deploys", async () => {
    const identity = (...more: string[]) => [
      "resource",
      "add",
      "deploy-identity",
      "--env",
      "staging",
      "--cloud",
      "gcp",
      "--name",
      "main",
      "--region",
      "us-central1",
      "--gcp-project",
      "my-proj-1234",
      "--forge",
      "github",
      "--repository",
      "acme/web",
      "--repository-id",
      "1234567",
      "--owner-id",
      "7654321",
      ...more,
      "--dry-run",
      ...where,
    ];
    // no service of that name in the project yet: the API says so, by key
    const alone = await orch(identity("--uses", "service:web"));
    expect(alone.code).toBe(1);
    expect(alone.err.join("\n")).toContain("uses: service:web is not a resource of staging");
    const made = await orch([
      "resource",
      "add",
      "service",
      "--env",
      "staging",
      "--cloud",
      "gcp",
      "--name",
      "web",
      "--region",
      "us-central1",
      "--gcp-project",
      "my-proj-1234",
      ...where,
    ]);
    expect(made.code).toBe(0);
    const r = await orch(identity("--uses", "service:web"));
    expect(r.code).toBe(0);
    expect(r.writes()).toEqual([]);
    expect(r.text).toContain("dry run: add staging-main-deploy-identity");
    expect(r.text).toContain("  infra/staging/main-deploy-identity/main.tf");
    expect(r.text).toContain("idle cost: none");
  });

  test("a viewer is refused by the API with its own wording", async () => {
    const r = await orch(bucket("nope"), "viewer");
    expect(r.code).toBe(1);
    expect(r.writes()).toEqual([]);
  });
});

describe("a mistake in the words exits 2 before the API is asked", () => {
  const cases: [string, string[], string][] = [
    ["no step", ["resource"], "usage:"],
    ["an unknown step", ["resource", "grow"], "usage:"],
    ["an unknown kind", ["resource", "add", "queue", ...where], "--kind must be one of"],
    [
      "a missing flag",
      ["resource", "add", "bucket", "--env", "staging", ...where],
      "add needs --cloud",
    ],
    [
      "an unknown cloud",
      [
        "resource",
        "add",
        "bucket",
        "--env",
        "s",
        "--cloud",
        "azure",
        "--name",
        "a",
        "--region",
        "r",
        ...where,
      ],
      "--cloud must be one of gcp, aws",
    ],
    ["a flag of another kind", bucket("a", "--port", "80"), "--port does not belong here"],
    [
      "a flag that is only for add",
      ["resource", "ls", "--cloud", "gcp", ...where],
      "--cloud does not belong here",
    ],
    ["a port that is not a number", service("--port", "http"), "--port must be a whole number"],
    ["a port out of range", service("--port", "70000"), "--port must be a whole number"],
    [
      "a profile that is not one",
      bucket("a", "--profile", "huge"),
      "--profile must be one of small, medium, large",
    ],
    [
      "a boolean that is not true or false",
      bucket("a", "--versioning", "yes"),
      "--versioning must be one of true, false",
    ],
    ["a forge that is not one", identityFlags("--forge", "bitbucket"), "--forge must be one of"],
    [
      "an id that is not a number",
      identityFlags("--repository-id", "abc"),
      "--repository-id must be a whole number above 0",
    ],
    [
      "a deploy identity flag on a bucket",
      bucket("a", "--forge", "github"),
      "--forge does not belong here",
    ],
    ["a name for blueprints", ["resource", "blueprints", "x"], "blueprints takes no name"],
    ["show without a name", ["resource", "show", ...where], "show takes one stack name"],
    [
      "change with nothing to change",
      ["resource", "change", "staging-files-bucket", ...where],
      "change needs at least one flag",
    ],
    [
      "change of a name",
      ["resource", "change", "staging-files-bucket", "--name", "x", ...where],
      "--name does not belong here",
    ],
  ];
  for (const [what, argv, says] of cases) {
    test(what, async () => {
      const r = await orch(argv);
      expect(r.code).toBe(2);
      expect(r.err.join("\n")).toContain(says);
      expect(r.writes()).toEqual([]);
    });
  }

  test("the API is not asked: no token is needed to be told", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["resource", "add", "queue", ...where], {
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: "http://127.0.0.1:1" },
      cwd: dir,
      home: dir,
      stdin: async () => "",
      open: async () => {},
      confirm: async () => true,
      version: "0.0.0",
      commands: resourceCommands(),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--kind must be one of");
  });
});

describe("orch resource ls, show and change", () => {
  test("ls is one line each, filtered by --env; a viewer may read", async () => {
    await orch(bucket("listed"));
    const r = await orch(["resource", "ls", ...where], "viewer");
    expect(r.code).toBe(0);
    expect(r.text).toContain("staging-listed-bucket  bucket  gcp  staging  proposed");
    expect((await orch(["resource", "ls", "--env", "prod", ...where])).text).toBe(
      "no resources in acme/infra",
    );
    const json = JSON.parse((await orch(["--json", "resource", "ls", ...where])).text);
    expect(json.resources.some((x: { stack: string }) => x.stack === "staging-listed-bucket")).toBe(
      true,
    );
  });

  test("show prints the request, the links and the inputs", async () => {
    await orch(bucket("shown"));
    const r = await orch(["resource", "show", "staging-shown-bucket", ...where]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("staging-shown-bucket  bucket on gcp in staging  proposed");
    expect(r.text).toContain("files  infra/staging/shown-bucket");
    expect(r.text).toMatch(/request {2}.*\/merge_requests\/\d+/);
    expect(r.text).toContain("url  -");
    expect(r.text).toContain('  region "us-central1"');
    const missing = await orch(["resource", "show", "staging-nothing-bucket", ...where]);
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toContain("no resource staging-nothing-bucket in acme/infra");
  });

  test("change puts the flags over the inputs it has and proposes again on the same request", async () => {
    await orch(bucket("grown"));
    const r = await orch([
      "resource",
      "change",
      "staging-grown-bucket",
      "--versioning",
      "true",
      ...where,
    ]);
    expect(r.code).toBe(0);
    expect(r.text.split("\n")[0]).toMatch(/^staging-grown-bucket: updated /);
    const [row] = (await rows()).filter((x) => x.stack === "staging-grown-bucket");
    expect(row?.inputs).toMatchObject({
      versioning: true,
      region: "us-central1",
      profile: "small",
    });
  });

  test("change --dry-run says `change` and writes nothing; a flag of another kind is a usage error", async () => {
    await orch(bucket("dryer"));
    const r = await orch([
      "resource",
      "change",
      "staging-dryer-bucket",
      "--versioning",
      "true",
      "--dry-run",
      ...where,
    ]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("dry run: change staging-dryer-bucket");
    expect(r.writes()).toEqual([]);
    const wrong = await orch([
      "resource",
      "change",
      "staging-dryer-bucket",
      "--port",
      "80",
      ...where,
    ]);
    expect(wrong.code).toBe(2);
    expect(wrong.err.join("\n")).toContain("--port is not a flag of a bucket");
  });
});
