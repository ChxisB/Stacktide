import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  createOrganization,
  createProject,
  createRun,
  createSession,
  moveRunStack,
  type NewResource,
  upsertResource,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { blueprintCatalog } from "@orch/iac";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let o1: string;
let o2: string;
let web: string;
let infra: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<
  "owner" | "admin" | "member" | "viewer" | "reporter" | "outsider",
  string
>;

let app: ReturnType<typeof makeApp>;
const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
  });

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  web = (await createProject(t.db, { organizationId: o1, name: "web" })).id;
  infra = (await createProject(t.db, { organizationId: o1, name: "infra" })).id;
  let gitlabId = 900;
  for (const [name, roles] of [
    ["owner", { orgRoles: { [o1]: "owner" }, projectRoles: {} }],
    ["admin", { orgRoles: { [o1]: "admin" }, projectRoles: {} }],
    ["member", { orgRoles: { [o1]: "member" }, projectRoles: {} }],
    ["viewer", { orgRoles: { [o1]: "viewer" }, projectRoles: {} }],
    // no role in the organization: a reporter on one project only
    ["reporter", { orgRoles: {}, projectRoles: { [web]: "reporter" } }],
    ["outsider", { orgRoles: { [o2]: "admin" }, projectRoles: {} }],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    roleTable.set(gitlabId, roles as unknown as Roles);
  }
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

async function call(who: keyof typeof people | undefined, path: string) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, { headers: who ? { cookie: people[who] } : {} }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const resourcesOf = (project = web, org = o1) =>
  `/organizations/${org}/projects/${project}/resources`;
type Item = { id: string; name: string; stack: string; state: string };

let n = 0;
/** A stored resource, as the propose route will leave it (BLP-16); the platform has made no cloud call. */
const store = async (over: Partial<NewResource> = {}) => {
  const name = over.name ?? `files${++n}`;
  const environment = over.environment ?? "staging";
  const kind = over.kind ?? "bucket";
  const row = await upsertResource(t.db, {
    organizationId: o1,
    projectId: web,
    environment,
    kind,
    cloud: "gcp",
    name,
    inputs: { versioning: true },
    stack: `${environment}-${name}-${kind}`,
    path: `infra/${environment}/${name}-${kind}`,
    proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
    ...over,
  });
  if (!row) throw new Error("not stored");
  return row;
};

const SHA = "a".repeat(40);
const planOf = (stack: string, project = web) =>
  createRun(t.db, {
    organizationId: o1,
    projectId: project,
    ref: "feature/x",
    sha: SHA,
    stacks: [stack],
  });

describe("the catalog of blueprints", () => {
  test("anyone signed in reads it, whatever their roles: it belongs to no organization", async () => {
    const want = JSON.parse(JSON.stringify(blueprintCatalog()));
    for (const who of ["owner", "viewer", "reporter", "outsider"] as const) {
      const res = await call(who, "/blueprints");
      expect([who, res.status]).toEqual([who, 200]);
      expect(res.json).toEqual(want);
    }
  });

  test("lists the kinds, what each may use, both clouds and the idle cost of each", async () => {
    const { kinds, profiles, inputs } = (await call("member", "/blueprints")).json;
    expect(kinds.map((k: { kind: string }) => k.kind)).toEqual([
      "network",
      "service",
      "postgres",
      "bucket",
      "deploy-identity",
    ]);
    expect(kinds.find((k: { kind: string }) => k.kind === "service").uses).toEqual([
      "network",
      "postgres",
      "bucket",
    ]);
    const aws = kinds[0].clouds.find((c: { cloud: string }) => c.cloud === "aws");
    expect(aws).toMatchObject({ version: "v1" });
    expect(aws.idleCost).toContain("NAT gateway");
    expect(profiles).toEqual(["small", "medium", "large"]);
    expect(inputs.oneOf).toHaveLength(5);
  });

  test("is refused to someone who is not signed in", async () => {
    expect((await call(undefined, "/blueprints")).status).toBe(401);
  });
});

describe("listing a project's resources", () => {
  test("a project reporter, an org viewer, a member and an admin all read them", async () => {
    const row = await store({ name: "listed" });
    for (const who of ["reporter", "viewer", "member", "admin", "owner"] as const) {
      const res = await call(who, resourcesOf());
      expect([who, res.status]).toEqual([who, 200]);
      const found = (res.json.items as Item[]).find((i) => i.id === row.id);
      expect([who, found?.name]).toEqual([who, "listed"]);
    }
  });

  test("each item has what the screen needs and nothing from the cloud or the repository's files", async () => {
    const row = await store({
      name: "shape",
      kind: "postgres",
      cloud: "aws",
      inputs: { profile: "small" },
    });
    const item = (await call("reporter", resourcesOf())).json.items.find(
      (i: Item) => i.id === row.id,
    );
    expect(Object.keys(item).sort()).toEqual(
      [
        "cloud",
        "consoleUrl",
        "createdAt",
        "environment",
        "id",
        "inputs",
        "kind",
        "name",
        "organizationId",
        "path",
        "projectId",
        "proposalUrl",
        "state",
        "stack",
        "updatedAt",
        "url",
      ].sort(),
    );
    expect(item).toMatchObject({
      organizationId: o1,
      projectId: web,
      environment: "staging",
      kind: "postgres",
      cloud: "aws",
      name: "shape",
      stack: "staging-shape-postgres",
      path: "infra/staging/shape-postgres",
      proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      inputs: { profile: "small" },
      state: "proposed",
    });
  });

  test("the state follows the stack's runs: proposed, applying, ready, failed", async () => {
    const a = await store({ name: "alpha" });
    const b = await store({ name: "bravo" });
    const c = await store({ name: "charlie" });
    const d = await store({ name: "delta" });
    const toApplying = async (stack: string, last: "applied" | "failed" | "applying") => {
      const run = await planOf(stack);
      const m = (from: "queued" | "planning" | "planned" | "applying", to: string) =>
        // biome-ignore lint/suspicious/noExplicitAny: the walk below only uses legal moves
        moveRunStack(t.db, o1, web, run.id, stack, from, to as any);
      await m("queued", "planning");
      if (last === "failed") return m("planning", "failed");
      await m("planning", "planned");
      await m("planned", "applying");
      if (last === "applied") await m("applying", "applied");
    };
    await toApplying(b.stack, "applying");
    await toApplying(c.stack, "applied");
    await toApplying(d.stack, "failed");
    const items = (await call("reporter", resourcesOf())).json.items as Item[];
    const stateOf = (id: string) => items.find((i) => i.id === id)?.state;
    expect([a.name, stateOf(a.id)]).toEqual(["alpha", "proposed"]);
    expect([b.name, stateOf(b.id)]).toEqual(["bravo", "applying"]);
    expect([c.name, stateOf(c.id)]).toEqual(["charlie", "ready"]);
    expect([d.name, stateOf(d.id)]).toEqual(["delta", "failed"]);
  });

  test("a stack in another project does not decide the state of this project's resource", async () => {
    const mine = await store({ name: "shared-name" });
    const run = await planOf(mine.stack, infra);
    await moveRunStack(t.db, o1, infra, run.id, mine.stack, "queued", "failed");
    const item = (await call("reporter", resourcesOf())).json.items.find(
      (i: Item) => i.id === mine.id,
    );
    expect(item.state).toBe("proposed");
  });

  test("pages by id: a page of one, then the next, until the cursor is null", async () => {
    await store({ name: "page-a" });
    await store({ name: "page-b" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        "viewer",
        `${resourcesOf()}?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.json.items.length).toBeLessThanOrEqual(1);
      seen.push(...res.json.items.map((i: Item) => i.id));
      cursor = res.json.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    const all = (await call("viewer", resourcesOf())).json.items.map((i: Item) => i.id);
    expect(seen).toEqual(all);
    expect(pages).toBeGreaterThan(1);
  });

  test("leaves out another project's resources", async () => {
    const other = await store({ name: "elsewhere", projectId: infra });
    const mine = (await call("viewer", resourcesOf())).json.items as Item[];
    expect(mine.map((i) => i.id)).not.toContain(other.id);
    const theirs = (await call("viewer", resourcesOf(infra))).json.items as Item[];
    expect(theirs.map((i) => i.id)).toEqual([other.id]);
  });

  test("an empty project lists nothing, with no next page", async () => {
    const lone = await createProject(t.db, { organizationId: o1, name: "lone" });
    const res = await call("viewer", resourcesOf(lone.id));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [], nextCursor: null });
  });

  test("someone from another organization is told there is no such project", async () => {
    await store({ name: "hidden" });
    const res = await call("outsider", resourcesOf());
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("hidden");
  });

  test("an unknown project is a 404, and someone not signed in is a 401", async () => {
    expect((await call("admin", resourcesOf(crypto.randomUUID()))).status).toBe(404);
    expect((await call(undefined, resourcesOf())).status).toBe(401);
  });

  test("a cursor that is not ours is a 400", async () => {
    expect((await call("viewer", `${resourcesOf()}?cursor=nonsense`)).status).toBe(400);
  });
});

describe("reading one resource", () => {
  test("a reporter reads it, with its state", async () => {
    const row = await store({ name: "one" });
    const res = await call("reporter", `${resourcesOf()}/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: row.id,
      name: "one",
      stack: row.stack,
      state: "proposed",
    });
  });

  test("the state of one is the state the list shows", async () => {
    const row = await store({ name: "same" });
    const run = await planOf(row.stack);
    await moveRunStack(t.db, o1, web, run.id, row.stack, "queued", "failed");
    const one = (await call("viewer", `${resourcesOf()}/${row.id}`)).json;
    const listed = (await call("viewer", resourcesOf())).json.items.find(
      (i: Item) => i.id === row.id,
    );
    expect(one.state).toBe("failed");
    expect(one).toEqual(listed);
  });

  test("another project's resource is not found under this project", async () => {
    const other = await store({ name: "not-here", projectId: infra });
    expect((await call("admin", `${resourcesOf()}/${other.id}`)).status).toBe(404);
    expect((await call("admin", `${resourcesOf(infra)}/${other.id}`)).status).toBe(200);
  });

  test("an unknown id is a 404 and a malformed one is a 422", async () => {
    expect((await call("admin", `${resourcesOf()}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("admin", `${resourcesOf()}/not-a-uuid`)).status).toBe(422);
  });

  test("someone from another organization gets a 404, someone not signed in a 401", async () => {
    const row = await store({ name: "guarded" });
    expect((await call("outsider", `${resourcesOf()}/${row.id}`)).status).toBe(404);
    expect((await call(undefined, `${resourcesOf()}/${row.id}`)).status).toBe(401);
  });
});
