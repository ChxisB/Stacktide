import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  connections,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  environments,
  organizations,
  projects,
  upsertUser,
  variables,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { unguardedRoutes } from "./guard";
import { LIMITS } from "./rate-limit";
import { sessionPrincipal } from "./session";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
const ids = {} as Record<"o1" | "o2" | "o3" | "p1" | "p2" | "e1", string>;
const people = {} as Record<
  "alice" | "bob" | "carol" | "dave" | "erin" | "frank",
  { id: string; token: string; gitlabId: number }
>;

type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const makeApp = () =>
  createApp({
    logger: createLogger({ write: () => {} }),
    db: t.db,
    principal: sessionPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
      platformAdmins: [people.frank.gitlabId],
    }),
    ready: async () => {},
  });

beforeAll(async () => {
  t = await createTestDb();
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.o3 = await org("three");
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  ids.e1 = (
    await createEnvironment(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      name: "Dev",
      slug: "dev",
    })
  ).id;

  let gitlabId = 100;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "frank"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    people[name] = { id: user.id, token, gitlabId };
  }
  const roles = (orgRoles: Roles["orgRoles"], projectRoles: Roles["projectRoles"] = {}) => ({
    orgRoles,
    projectRoles,
  });
  roleTable.set(people.alice.gitlabId, roles({ [ids.o1]: "owner", [ids.o3]: "owner" }));
  roleTable.set(people.bob.gitlabId, roles({ [ids.o1]: "viewer" }));
  roleTable.set(people.carol.gitlabId, roles({}, { [ids.p1]: "maintainer" }));
  roleTable.set(people.dave.gitlabId, roles({ [ids.o2]: "owner" }));
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

type Who = keyof typeof people | "nobody";
async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who !== "nobody") headers.cookie = `orch_session=${people[who].token}`;
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
  return { status: res.status, json: (text ? JSON.parse(text) : undefined) as any };
}

const orgPath = () => `/organizations/${ids.o1}`;
const projectPath = (p = ids.p1) => `${orgPath()}/projects/${p}`;
const envPath = () => `${projectPath()}/environments`;
const connPath = () => `${orgPath()}/connections`;
const NO_CONNECTION = "00000000-0000-4000-8000-000000000001";

/** Every write the API has, aimed at the data seeded above. */
const writes = () =>
  [
    ["POST", "/organizations", { slug: "nope", name: "Nope" }],
    ["PATCH", orgPath(), { name: "Renamed" }],
    ["DELETE", orgPath()],
    ["POST", `${orgPath()}/projects`, { name: "nope" }],
    ["PATCH", projectPath(), { name: "Renamed" }],
    ["DELETE", projectPath()],
    ["POST", envPath(), { name: "Nope", slug: "nope" }],
    ["PATCH", `${envPath()}/${ids.e1}`, { name: "Renamed" }],
    ["DELETE", `${envPath()}/${ids.e1}`],
    [
      "POST",
      connPath(),
      {
        type: "gitlab",
        name: "nope",
        baseUrl: "https://gitlab.example.com",
        token: "glpat-0123456789",
      },
    ],
    ["POST", `${connPath()}/${NO_CONNECTION}/test`],
    ["DELETE", `${connPath()}/${NO_CONNECTION}`],
    ...[
      `${orgPath()}/variables`,
      `${projectPath()}/variables`,
      `${envPath()}/${ids.e1}/variables`,
    ].flatMap(
      (path) =>
        [
          ["POST", path, { key: "NOPE", kind: "plain", value: "v" }],
          ["PATCH", `${path}/${NO_CONNECTION}`, { value: "x" }],
          ["DELETE", `${path}/${NO_CONNECTION}`],
          ["POST", `${path}/${NO_CONNECTION}/restore`, { version: 1 }],
          ["POST", `${path}/restore`, { at: "2020-01-01T00:00:00Z", prune: true }],
          ["POST", `${path}/import`, { source: "dotenv", content: "NOPE=1", dryRun: false }],
          ["POST", `${path}/bulk`, { ops: [{ op: "delete", key: "NOPE" }], dryRun: false }],
        ] as const,
    ),
  ] as const;

async function rowCounts() {
  const n = async (
    table:
      | typeof organizations
      | typeof projects
      | typeof environments
      | typeof connections
      | typeof variables,
  ) => (await t.db.select({ n: count() }).from(table))[0]?.n;
  return [
    await n(organizations),
    await n(projects),
    await n(environments),
    await n(connections),
    await n(variables),
  ];
}

describe("coverage", () => {
  const detailOf = (r: { hooks?: unknown }) =>
    (r.hooks as { detail?: Record<string, unknown> } | undefined)?.detail ?? {};

  test("every route declares a guard, signedIn or public; only the OpenAPI document is exempt", () => {
    expect(unguardedRoutes(app)).toEqual(["GET /openapi/json"]);
  });

  /** The thirteen routes of one level of variables. */
  const variableGuards = (path: string, family: string, reveal: string) => ({
    [`GET ${path}`]: `${family}.read`,
    [`POST ${path}`]: `${family}.create`,
    [`GET ${path}/:varId`]: `${family}.read`,
    [`PATCH ${path}/:varId`]: `${family}.update`,
    [`DELETE ${path}/:varId`]: `${family}.delete`,
    [`GET ${path}/:varId/versions`]: `${family}.read`,
    [`GET ${path}/:varId/value`]: reveal,
    [`POST ${path}/:varId/restore`]: `${family}.restore`,
    [`GET ${path}/snapshot`]: `${family}.read`,
    [`GET ${path}/restore-plan`]: `${family}.restore`,
    [`POST ${path}/restore`]: `${family}.restore`,
    [`POST ${path}/import`]: `${family}.import`,
    [`POST ${path}/bulk`]: `${family}.bulk`,
  });

  /** The four routes that say how one secret rotates. */
  const rotationGuards = (path: string, family: string) => ({
    [`GET ${path}/:varId/rotation`]: `${family}.rotation.read`,
    [`PUT ${path}/:varId/rotation`]: `${family}.rotation.manage`,
    [`DELETE ${path}/:varId/rotation`]: `${family}.rotation.manage`,
    [`POST ${path}/:varId/rotation/rotate`]: `${family}.rotation.run`,
  });

  test("the guard of every route, written out", () => {
    const guards = Object.fromEntries(
      app.routes.map((r) => [`${r.method} ${r.path}`, detailOf(r)["x-guard"]]),
    );
    const O = "/organizations";
    const P = `${O}/:orgId/projects`;
    const E = `${P}/:projectId/environments`;
    expect(Object.fromEntries(Object.entries(guards).filter(([, g]) => g !== undefined))).toEqual({
      [`POST ${O}`]: "organization.create",
      [`GET ${O}/:orgId`]: "organization.read",
      [`GET ${O}/:orgId/access`]: "organization.read",
      [`GET ${O}/:orgId/members`]: "member.read",
      [`PATCH ${O}/:orgId`]: "organization.update",
      [`DELETE ${O}/:orgId`]: "organization.delete",
      [`GET ${P}`]: "organization.read",
      [`POST ${P}`]: "project.create",
      [`GET ${P}/:projectId`]: "project.read",
      [`PATCH ${P}/:projectId`]: "project.update",
      [`DELETE ${P}/:projectId`]: "project.delete",
      [`GET ${E}`]: "environment.read",
      [`POST ${E}`]: "environment.create",
      [`GET ${E}/:envId`]: "environment.read",
      [`PATCH ${E}/:envId`]: "environment.update",
      [`DELETE ${E}/:envId`]: "environment.delete",
      [`GET ${P}/:projectId/folders`]: "variable.read",
      [`POST ${P}/:projectId/folders`]: "variable.create",
      [`PATCH ${P}/:projectId/folders/:folderId`]: "variable.update",
      [`DELETE ${P}/:projectId/folders/:folderId`]: "variable.delete",
      [`PUT ${E}/:envId/protection`]: "environment.protect",
      [`GET ${E}/:envId/change-requests`]: "change_request.read",
      [`POST ${E}/:envId/change-requests`]: "change_request.create",
      [`GET ${E}/:envId/change-requests/:crId`]: "change_request.read",
      [`POST ${E}/:envId/change-requests/:crId/approve`]: "change_request.approve",
      [`POST ${E}/:envId/change-requests/:crId/reject`]: "change_request.reject",
      [`GET ${P}/:projectId/sync-targets`]: "sync.target.read",
      [`POST ${P}/:projectId/sync-targets`]: "sync.target.create",
      [`GET ${P}/:projectId/sync-targets/:targetId`]: "sync.target.read",
      [`PATCH ${P}/:projectId/sync-targets/:targetId`]: "sync.target.update",
      [`DELETE ${P}/:projectId/sync-targets/:targetId`]: "sync.target.delete",
      [`POST ${P}/:projectId/sync-targets/:targetId/plan`]: "sync.plan",
      [`POST ${P}/:projectId/sync-targets/:targetId/apply`]: "sync.apply",
      [`GET ${P}/:projectId/sync-targets/:targetId/runs/:runId`]: "sync.run.read",
      [`GET ${P}/:projectId/sync-targets/:targetId/last-run`]: "sync.run.read",
      [`GET ${P}/:projectId/sync-targets/:targetId/drift`]: "sync.target.read",
      [`GET ${P}/:projectId/leases`]: "lease.read",
      [`POST ${P}/:projectId/leases`]: "lease.issue",
      [`DELETE ${P}/:projectId/leases/:leaseId`]: "lease.revoke",
      [`GET ${P}/:projectId/findings`]: "finding.read",
      [`GET ${P}/:projectId/findings/:findingId`]: "finding.read",
      [`POST ${P}/:projectId/findings/:findingId/dismiss`]: "finding.dismiss",
      [`POST ${P}/:projectId/findings/:findingId/reopen`]: "finding.reopen",
      [`GET ${P}/:projectId/pipeline`]: "pipeline.read",
      [`POST ${P}/:projectId/pipeline/preview`]: "pipeline.apply",
      [`POST ${P}/:projectId/pipeline`]: "pipeline.apply",
      [`GET ${O}/:orgId/pipeline-upgrades`]: "pipeline.upgrade",
      [`POST ${O}/:orgId/pipeline-upgrades/plan`]: "pipeline.upgrade",
      [`POST ${O}/:orgId/pipeline-upgrades`]: "pipeline.upgrade",
      [`GET ${O}/:orgId/template-registry`]: "template.registry.read",
      [`GET ${P}/:projectId/pipeline-runs`]: "pipeline.read",
      [`GET ${P}/:projectId/pipeline-runs/latest`]: "pipeline.read",
      [`GET ${P}/:projectId/pipeline-runs/:runId/jobs`]: "pipeline.read",
      [`POST ${P}/:projectId/pipeline-runs/:runId/retry`]: "pipeline.retry",
      [`GET ${P}/:projectId/deployments`]: "deployment.read",
      [`GET ${P}/:projectId/deployments/environments`]: "deployment.read",
      [`GET ${P}/:projectId/deployments/stats`]: "deployment.read",
      [`POST ${P}/:projectId/deployments/refresh`]: "deployment.refresh",
      [`POST ${P}/:projectId/deployments/promote`]: "deployment.promote",
      [`POST ${P}/:projectId/deployments/rollback`]: "deployment.rollback",
      [`GET ${P}/:projectId/runs`]: "run.read",
      [`POST ${P}/:projectId/runs`]: "run.create",
      [`GET ${P}/:projectId/runs/:runId`]: "run.read",
      [`POST ${P}/:projectId/runs/:runId/plan-summary`]: "run.summary",
      [`GET ${P}/:projectId/runs/:runId/plan`]: "run.summary",
      [`POST ${P}/:projectId/runs/:runId/policy-verdict`]: "run.summary",
      [`GET ${P}/:projectId/state/:stack`]: "state.read",
      [`GET ${P}/:projectId/state/:stack/resources`]: "state.list",
      [`GET ${P}/:projectId/state/:stack/versions`]: "state.list",
      [`POST ${P}/:projectId/state/:stack`]: "state.write",
      [`DELETE ${P}/:projectId/state/:stack`]: "state.write",
      [`LOCK ${P}/:projectId/state/:stack`]: "state.write",
      [`UNLOCK ${P}/:projectId/state/:stack`]: "state.write",
      [`POST ${P}/:projectId/state/:stack/lock`]: "state.write",
      [`DELETE ${P}/:projectId/state/:stack/lock`]: "state.write",
      [`POST ${P}/:projectId/state/:stack/import`]: "state.import",
      [`POST ${P}/:projectId/state/:stack/force-unlock`]: "state.force_unlock",
      [`POST ${P}/:projectId/runs/:runId/apply`]: "run.apply",
      [`GET ${P}/:projectId/resources`]: "resource.read",
      [`GET ${P}/:projectId/resources/:id`]: "resource.read",
      [`POST ${P}/:projectId/resources`]: "resource.propose",
      [`POST ${P}/:projectId/resources/preview`]: "resource.propose",
      [`PATCH ${P}/:projectId/resources/:id`]: "resource.propose",
      [`GET ${O}/:orgId/connections`]: "connection.read",
      [`POST ${O}/:orgId/connections`]: "connection.create",
      [`POST ${O}/:orgId/connections/:connectionId/test`]: "connection.test",
      [`DELETE ${O}/:orgId/connections/:connectionId`]: "connection.delete",
      [`GET ${O}/:orgId/connections/:connectionId/gitlab-projects`]: "project.import",
      [`POST ${O}/:orgId/connections/:connectionId/imports`]: "project.import",
      [`POST ${O}/:orgId/connections/:connectionId/webhook-secret`]: "connection.webhook",
      [`GET ${O}/:orgId/notification-sinks`]: "notification.sink.read",
      [`POST ${O}/:orgId/notification-sinks`]: "notification.sink.create",
      [`DELETE ${O}/:orgId/notification-sinks/:sinkId`]: "notification.sink.delete",
      [`GET ${O}/:orgId/notification-sinks/:sinkId/audit-forwarding`]: "audit.forwarding.read",
      [`PUT ${O}/:orgId/notification-sinks/:sinkId/audit-forwarding`]: "audit.forwarding.update",
      [`DELETE ${O}/:orgId/notification-sinks/:sinkId/audit-forwarding`]: "audit.forwarding.update",
      [`GET ${O}/:orgId/audit-events`]: "audit.read",
      [`GET ${O}/:orgId/audit-events/export`]: "audit.export",
      [`GET ${O}/:orgId/audit-retention`]: "audit.retention.read",
      [`PUT ${O}/:orgId/audit-retention`]: "audit.retention.update",
      [`GET ${O}/:orgId/policy-sets`]: "policy.set.read",
      [`POST ${O}/:orgId/policy-sets`]: "policy.set.create",
      [`DELETE ${O}/:orgId/policy-sets/:setId`]: "policy.set.delete",
      [`GET ${O}/:orgId/cost-limits`]: "cost.limit.read",
      [`PUT ${O}/:orgId/cost-limits`]: "cost.limit.set",
      [`DELETE ${O}/:orgId/cost-limits/:limitId`]: "cost.limit.delete",
      [`GET ${O}/:orgId/dns/zones`]: "dns.zone.read",
      [`POST ${O}/:orgId/dns/zones`]: "dns.zone.create",
      [`DELETE ${O}/:orgId/dns/zones/:zoneId`]: "dns.zone.delete",
      [`GET ${O}/:orgId/secret-gate`]: "secret.gate.read",
      [`PUT ${O}/:orgId/secret-gate`]: "secret.gate.update",
      [`GET ${O}/:orgId/pools`]: "pool.read",
      [`GET ${O}/:orgId/pools/:poolId`]: "pool.read",
      [`POST ${O}/:orgId/pools`]: "pool.create",
      [`PATCH ${O}/:orgId/pools/:poolId`]: "pool.update",
      [`DELETE ${O}/:orgId/pools/:poolId`]: "pool.delete",
      [`GET ${O}/:orgId/projects/:projectId/pools/:poolId/status`]: "pool.status",
      [`GET ${O}/:orgId/sso`]: "sso.read",
      [`PUT ${O}/:orgId/sso`]: "sso.manage",
      [`PATCH ${O}/:orgId/sso`]: "sso.manage",
      [`DELETE ${O}/:orgId/sso`]: "sso.manage",
      [`POST ${O}/:orgId/sso/test`]: "sso.manage",
      [`POST ${O}/:orgId/sso/enable`]: "sso.manage",
      [`POST ${O}/:orgId/sso/disable`]: "sso.manage",
      [`GET ${P}/:projectId/notifications`]: "notification.subscription.read",
      [`PUT ${P}/:projectId/notifications/:sinkId`]: "notification.subscription.update",
      [`DELETE ${P}/:projectId/notifications/:sinkId`]: "notification.subscription.update",
      ...variableGuards(`${O}/:orgId/variables`, "variable.org", "secret.reveal.org"),
      ...variableGuards(`${P}/:projectId/variables`, "variable", "secret.reveal"),
      ...variableGuards(`${E}/:envId/variables`, "variable", "secret.reveal"),
      ...rotationGuards(`${O}/:orgId/variables`, "variable.org"),
      ...rotationGuards(`${P}/:projectId/variables`, "variable"),
      ...rotationGuards(`${E}/:envId/variables`, "variable"),
      [`GET ${E}/:envId/resolved-variables`]: "variable.read",
      [`GET ${E}/:envId/resolved-variables/values`]: "secret.reveal",
      [`GET ${P}/:projectId/variable-changes`]: "variable.read",
      [`POST ${O}/:orgId/variable-search`]: "variable.org.read",
    });
  });

  test("the public and signed-in routes, written out", () => {
    const marked = (key: string) =>
      app.routes.filter((r) => detailOf(r)[key] !== undefined).map((r) => `${r.method} ${r.path}`);
    expect(marked("x-public").sort()).toEqual([
      "DELETE /auth/identities/:id",
      "GET /auth/callback",
      "GET /auth/cli",
      "GET /auth/github/callback",
      "GET /auth/github/login",
      "GET /auth/identities",
      "GET /auth/login",
      "GET /auth/me",
      "GET /auth/sso/:slug/login",
      "GET /auth/sso/callback",
      "GET /health",
      "GET /metrics",
      "GET /ready",
      "POST /auth/ci/exchange",
      "POST /auth/cli/token",
      "POST /auth/logout",
      "POST /auth/sso/:slug/link",
      "POST /webhooks/github/:connectionId",
      "POST /webhooks/gitlab/:connectionId",
    ]);
    expect(marked("x-signed-in").sort()).toEqual([
      "DELETE /tokens/:tokenId",
      "GET /auth/whoami",
      "GET /blueprints",
      "GET /organizations",
      "GET /tokens",
      "POST /auth/cli/logout",
      "POST /tokens",
    ]);
  });

  test("the rate limit of every route that has one, written out", () => {
    const limited = Object.fromEntries(
      app.routes
        .filter((r) => detailOf(r)["x-rate-limit"] !== undefined)
        .map((r) => [`${r.method} ${r.path}`, detailOf(r)["x-rate-limit"]]),
    );
    const V = "/organizations/:orgId/projects/:projectId/environments/:envId";
    expect(limited).toEqual({
      "GET /auth/login": "login",
      "GET /auth/callback": "login",
      "GET /auth/cli": "login",
      "GET /auth/github/login": "login",
      "GET /auth/github/callback": "login",
      "GET /auth/sso/:slug/login": "login",
      "GET /auth/sso/callback": "login",
      "POST /auth/sso/:slug/link": "login",
      "POST /auth/cli/token": "login",
      "POST /auth/ci/exchange": "ci_exchange",
      "POST /webhooks/github/:connectionId": "webhook",
      "POST /webhooks/gitlab/:connectionId": "webhook",
      "POST /tokens": "token_create",
      "POST /organizations/:orgId/variables/:varId/rotation/rotate": "rotation_run",
      "POST /organizations/:orgId/projects/:projectId/variables/:varId/rotation/rotate":
        "rotation_run",
      [`POST ${V}/variables/:varId/rotation/rotate`]: "rotation_run",
      "POST /organizations/:orgId/projects/:projectId/leases": "lease_issue",
      "GET /organizations/:orgId/variables/:varId/value": "reveal",
      "GET /organizations/:orgId/projects/:projectId/variables/:varId/value": "reveal",
      [`GET ${V}/variables/:varId/value`]: "reveal",
      [`GET ${V}/resolved-variables/values`]: "reveal",
    });
    // every class is in use, and nothing reads a secret's value without the reveal limit
    expect([...new Set(Object.values(limited))].sort()).toEqual(Object.keys(LIMITS).sort());
    const reveals = app.routes.filter((r) =>
      String(detailOf(r)["x-guard"]).startsWith("secret.reveal"),
    );
    expect(reveals.length).toBeGreaterThan(0);
    for (const r of reveals)
      expect([r.path, detailOf(r)["x-rate-limit"]]).toEqual([r.path, "reveal"]);
  });
});

describe("without a session", () => {
  const fill = (p: string) =>
    p
      .replace(":orgId", ids.o1)
      .replace(":projectId", ids.p1)
      .replace(":envId", ids.e1)
      .replace(":tokenId", crypto.randomUUID())
      .replace(":varId", NO_CONNECTION)
      .replace(":targetId", NO_CONNECTION)
      .replace(":runId", NO_CONNECTION)
      .replace(":sinkId", NO_CONNECTION)
      .replace(":connectionId", NO_CONNECTION);

  test("every route that is not public answers 401", async () => {
    const open = new Set(["GET /openapi/json"]);
    const routes = app.routes.filter((r) => {
      const d = (r.hooks as { detail?: Record<string, unknown> } | undefined)?.detail ?? {};
      return d["x-public"] === undefined && !open.has(`${r.method} ${r.path}`);
    });
    expect(routes.length).toBe(189);
    for (const r of routes) {
      const res = await call("nobody", r.method, fill(r.path), r.method === "GET" ? undefined : {});
      expect([r.method, r.path, res.status, res.json?.code]).toEqual([
        r.method,
        r.path,
        401,
        "unauthenticated",
      ]);
    }
  });

  test("a bad, ended or foreign cookie is no session either", async () => {
    for (const cookie of ["orch_session=nope", `orch_session=${hashToken(people.alice.token)}`]) {
      const res = await app.handle(
        new Request(`http://localhost${orgPath()}`, { headers: { cookie } }),
      );
      expect(res.status).toBe(401);
    }
  });

  test("the public routes still work", async () => {
    expect((await call("nobody", "GET", "/health")).status).toBe(200);
    expect((await call("nobody", "GET", "/ready")).status).toBe(200);
    expect((await call("nobody", "GET", "/openapi/json")).status).toBe(200);
    // Sign-in is not configured here: 503 is the route's own answer, not a 401 from the guard.
    expect((await call("nobody", "GET", "/auth/login")).status).toBe(503);
    expect((await call("nobody", "GET", "/auth/me")).status).toBe(401);
  });
});

describe("who may write", () => {
  test("a signed-in caller with no role can change nothing, and cannot see anything", async () => {
    const before = await rowCounts();
    const events = await t.db.select({ n: count() }).from(auditEvents);
    for (const [method, path, body] of writes()) {
      const res = await call("erin", method, path, body);
      const want = method === "POST" && path === "/organizations" ? 403 : 404;
      expect([method, path, res.status]).toEqual([method, path, want]);
    }
    for (const path of [orgPath(), `${orgPath()}/projects`, projectPath(), envPath()]) {
      expect([path, (await call("erin", "GET", path)).status]).toEqual([path, 404]);
    }
    expect(await rowCounts()).toEqual(before);
    expect(await t.db.select({ n: count() }).from(auditEvents)).toEqual(events);
  });

  test("a viewer reads everything in the org and writes nothing", async () => {
    const before = await rowCounts();
    for (const path of [orgPath(), `${orgPath()}/projects`, projectPath(), envPath()]) {
      expect([path, (await call("bob", "GET", path)).status]).toEqual([path, 200]);
    }
    for (const [method, path, body] of writes()) {
      expect([method, path, (await call("bob", method, path, body)).status]).toEqual([
        method,
        path,
        403,
      ]);
    }
    expect(await rowCounts()).toEqual(before);
  });

  test("an owner of another org gets nothing here, also with ids that do not match its org", async () => {
    const before = await rowCounts();
    for (const [method, path, body] of writes()) {
      const res = await call("dave", method, path, body);
      const want = method === "POST" && path === "/organizations" ? 403 : 404;
      expect([method, path, res.status]).toEqual([method, path, want]);
    }
    // Dave owns o2 and names it in the path, but the project and environment are o1's.
    const crossed = `/organizations/${ids.o2}/projects/${ids.p1}`;
    expect((await call("dave", "PATCH", crossed, { name: "Hijacked" })).status).toBe(404);
    expect((await call("dave", "DELETE", crossed)).status).toBe(404);
    expect(
      (await call("dave", "POST", `${crossed}/environments`, { name: "X", slug: "x" })).status,
    ).toBe(404);
    expect((await call("dave", "DELETE", `${crossed}/environments/${ids.e1}`)).status).toBe(404);
    expect(await rowCounts()).toEqual(before);
    const [p1] = await t.db.select().from(projects).where(eq(projects.id, ids.p1));
    expect(p1?.name).toBe("p1");
  });

  test("a project maintainer works on that project only", async () => {
    expect((await call("carol", "GET", projectPath())).status).toBe(200);
    expect((await call("carol", "PATCH", projectPath(), { name: "p1b" })).status).toBe(200);
    expect((await call("carol", "PATCH", projectPath(), { name: "p1" })).status).toBe(200);
    expect((await call("carol", "GET", envPath())).status).toBe(200);
    expect((await call("carol", "POST", envPath(), { name: "Tmp", slug: "tmp" })).status).toBe(201);
    // No org role: the org, its project list and its other projects are invisible; deleting needs org admin.
    expect((await call("carol", "GET", orgPath())).status).toBe(404);
    expect((await call("carol", "GET", `${orgPath()}/projects`)).status).toBe(404);
    expect((await call("carol", "GET", projectPath(ids.p2))).status).toBe(404);
    expect((await call("carol", "DELETE", projectPath())).status).toBe(403);
  });

  test("an owner does it all, and the audit row names the user", async () => {
    const created = await call("alice", "POST", `${orgPath()}/projects`, { name: "by-alice" });
    expect(created.status).toBe(201);
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, created.json.id));
    expect(row).toMatchObject({ actorKind: "user", actorId: people.alice.id });
    expect((await call("alice", "DELETE", projectPath(created.json.id))).status).toBe(204);
  });

  test("a platform admin may create an organization, and holds no role in it afterwards", async () => {
    const res = await call("frank", "POST", "/organizations", { slug: "by-frank", name: "F" });
    expect(res.status).toBe(201);
    // Roles come from GitLab membership (AUTH-5): until then the creator cannot even read it.
    expect((await call("frank", "GET", `/organizations/${res.json.id}`)).status).toBe(404);
  });

  test("/auth/me says who may create organizations, so a screen can offer it", async () => {
    const asked = async (who: Who) => (await call(who, "GET", "/auth/me")).json.platformAdmin;
    expect(await asked("frank")).toBe(true);
    for (const who of ["alice", "bob", "carol", "erin"] as const)
      expect(await asked(who)).toBe(false);
  });
});

describe("/auth/me with a principal that is not the cookie's person", () => {
  test("it says what the session's own person may do, not what the other caller may", async () => {
    // a call that carries alice's cookie but is authenticated as frank (as a bearer token would)
    const asFrank = sessionPrincipal({
      db: t.db,
      platformAdmins: [people.frank.gitlabId],
    });
    const mixed = createApp({
      logger: createLogger({ write: () => {} }),
      db: t.db,
      principal: (request) =>
        asFrank(
          new Request(request.url, { headers: { cookie: `orch_session=${people.frank.token}` } }),
        ),
      ready: async () => {},
    });
    const res = await mixed.handle(
      new Request("http://localhost/auth/me", {
        headers: { cookie: `orch_session=${people.alice.token}` },
      }),
    );
    expect(await res.json()).toMatchObject({ username: "alice", platformAdmin: false });
  });
});

describe("organization list", () => {
  const listed = async (who: Who, query = "") => {
    const res = await call(who, "GET", `/organizations${query}`);
    expect(res.status).toBe(200);
    return res.json as { items: { id: string }[]; nextCursor: string | null };
  };

  test("a caller sees the organizations it holds a role in, and no others", async () => {
    const seen = async (who: Who) => (await listed(who)).items.map((o) => o.id).sort();
    expect(await seen("alice")).toEqual([ids.o1, ids.o3].sort());
    expect(await seen("bob")).toEqual([ids.o1]);
    expect(await seen("dave")).toEqual([ids.o2]);
    expect(await seen("erin")).toEqual([]);
    expect(await seen("carol")).toEqual([]); // a project role alone does not open the org
  });

  test("paging keeps the filter", async () => {
    const first = await listed("alice", "?limit=1");
    expect(first.items.length).toBe(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listed("alice", `?limit=1&cursor=${first.nextCursor}`);
    expect(second.items.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0]?.id, second.items[0]?.id].sort()).toEqual([ids.o1, ids.o3].sort());
  });
});

describe("what a caller may do in an organization", () => {
  const access = (who: Who, org = ids.o1) => call(who, "GET", `/organizations/${org}/access`);

  test("an owner, a viewer and a project maintainer are told their own role and actions", async () => {
    const alice = await access("alice");
    expect(alice.status).toBe(200);
    expect(alice.json.role).toBe("owner");
    expect(alice.json.actions).toContain("connection.read");
    expect(alice.json.actions).toContain("organization.delete");
    const bob = await access("bob");
    expect(bob.json.role).toBe("viewer");
    expect(bob.json.actions).toContain("organization.read");
    expect(bob.json.actions).not.toContain("connection.read");
    // a role on one project does not open the organization
    expect((await access("carol")).status).toBe(404);
  });

  test("it is the caller's own: another organization's owner, and nobody, learn nothing", async () => {
    expect((await access("dave")).status).toBe(404);
    expect((await access("erin")).status).toBe(404);
    expect((await access("nobody")).status).toBe(401);
    // alice owns o3, and is told the role she holds there, not the one she holds in o1
    expect((await access("alice", ids.o3)).json.role).toBe("owner");
    expect((await access("bob", ids.o3)).status).toBe(404);
  });

  test("the answer is the caller's alone: no shared cache keeps it and it names no one", async () => {
    const res = await app.handle(
      new Request(`http://localhost/organizations/${ids.o1}/access`, {
        headers: { cookie: `orch_session=${people.alice.token}` },
      }),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["actions", "role"]);
  });
});
