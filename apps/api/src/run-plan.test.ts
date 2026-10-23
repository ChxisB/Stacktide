import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  createCiToken,
  createOrganization,
  createProject,
  createRun,
  createSession,
  storeRunPlan,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { type PlanInput, runPlan, runPlanSchema, type Stack } from "@orch/iac";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newCiToken, randomToken } from "./tokens";

// FRG-17: the plan of a run as data, read by a CI job of the project.

let t: TestDb;
let app: ReturnType<typeof createApp>;
const ids = {} as Record<"org" | "p1" | "p2" | "run", string>;
let user = "";
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const stack = (name: string, over: Partial<Stack> = {}): Stack => ({
  name,
  path: `stacks/${name}`,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
  ...over,
});

// the platform's own token is only ever a reference in a command; this stands for a value that must never be in one
const CANARY = "orch_ci_CANARY-7f3a91c2";
const input: PlanInput = {
  action: "plan",
  stacks: [stack("net"), stack("app", { dependsOn: ["net"], environment: "prod" })],
  select: ["net", "app"],
  audience: "orch.example.com",
  apiUrl: "https://orch.example.com",
  summaryPath: "/runs/r/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  images: { tofu: "registry.example.com/tofu-orch" },
};

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.org, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.org, name: "p2" })).id;
  ids.run = (
    await createRun(t.db, {
      organizationId: ids.org,
      projectId: ids.p1,
      ref: "main",
      sha: "a".repeat(40),
      stacks: ["net", "app"],
    })
  ).id;
  await storeRunPlan(t.db, ids.org, ids.p1, ids.run, "plan", runPlan(input));
  const u = await upsertUser(t.db, { gitlabId: 701, username: "alice", name: "Alice" });
  const session = randomToken();
  await createSession(t.db, { userId: u.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  user = `orch_session=${session}`;
  roleTable.set(701, { orgRoles: { [ids.org]: "owner" }, projectRoles: {} });
  app = createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (x) => roleTable.get(x.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
  });
});
afterAll(async () => {
  await t.drop();
});

/** A CI token as `/auth/ci/exchange` issues it to a job in no environment. */
async function ciToken(over: { projectId?: string; scopes?: string[] } = {}) {
  const fresh = newCiToken();
  await createCiToken(t.db, {
    organizationId: ids.org,
    projectId: over.projectId ?? ids.p1,
    tokenHash: fresh.tokenHash,
    scopes: over.scopes ?? ["project.read", "run.summary"],
    gitlabProjectId: 4242,
    gitlabJobId: 901,
    ref: "main",
    refProtected: false,
    ttlMs: 60_000,
  });
  return fresh.token;
}

const get = async (
  headers: Record<string, string>,
  project = ids.p1,
  query = "",
  run = ids.run,
) => {
  const res = await app.handle(
    new Request(
      `http://localhost/organizations/${ids.org}/projects/${project}/runs/${run}/plan${query}`,
      { headers },
    ),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /runs/:runId/plan", () => {
  test("the project's CI token reads the plan as it was kept", async () => {
    const res = await get(bearer(await ciToken()));
    expect(res.status).toBe(200);
    expect(runPlanSchema.parse(res.json)).toEqual(runPlan(input));
    expect(res.json.levels.map((l: { name: string }[]) => l.map((s) => s.name))).toEqual([
      ["net"],
      ["app"],
    ]);
  });

  test("an action with no plan kept, a run of no plan and an unknown run are not found", async () => {
    const token = bearer(await ciToken());
    expect((await get(token, ids.p1, "?action=apply")).status).toBe(404);
    expect((await get(token, ids.p1, "", crypto.randomUUID())).status).toBe(404);
    expect((await get(token, ids.p1, "?action=destroy")).status).toBe(422);
  });

  test("another project's CI token, and a token without the scope, are refused", async () => {
    // not found, as the platform answers a token of another project: it does not say the run is there
    expect((await get(bearer(await ciToken({ projectId: ids.p2 })))).status).toBe(404);
    // and the run under its own project's path is no plan of the other project's, whoever asks
    expect((await get(bearer(await ciToken({ projectId: ids.p2 })), ids.p2)).status).toBe(404);
    expect((await get(bearer(await ciToken({ scopes: ["project.read"] })))).status).toBe(403);
  });

  test("a person is refused, an owner among them, and so is no one", async () => {
    expect((await get({ cookie: user })).status).toBe(403);
    expect((await get({})).status).toBe(401);
  });

  test("it holds names and references: the token and a value kept nowhere are not in it", async () => {
    const token = await ciToken();
    const res = await get(bearer(token));
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(CANARY);
    // the platform's token is there only as the variable a job resolves
    expect(res.text).toContain("$ORCH_TOKEN");
  });
});
