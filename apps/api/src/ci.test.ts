import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import {
  auditEvents,
  ciTokens,
  createEnvironment,
  createOrganization,
  createProject,
  deleteProject,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { GitlabError, type Jwk } from "@orch/gitlab";
import { count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { b64, makeKey, type Signer, sign } from "./jwt-testing";
import { hashToken, isCiToken } from "./tokens";

const ISSUER = "https://gitlab.example.com";
const AUDIENCE = "orch.example.com";

let t: TestDb;
let signer: Signer;
let stranger: Signer;
const lines: Record<string, unknown>[] = [];
const ids = {} as Record<
  "o1" | "p1" | "stagingP1" | "productionP1" | "o2" | "p2" | "stagingP2",
  string
>;
let keysDown = false;

const logger = createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l)) });
const makeApp = (ci: boolean) =>
  createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db }),
    ready: async () => {},
    ci: ci
      ? {
          key: async (kid) => {
            if (keysDown)
              throw new GitlabError("network", "GitLab GET /oauth/discovery/keys failed");
            return [signer.jwk, stranger.jwk].find((k: Jwk) => k.kid === kid);
          },
          issuer: ISSUER,
          audience: AUDIENCE,
        }
      : undefined,
  });
let app: ReturnType<typeof makeApp>;

const GITLAB_P1 = 5001;
const GITLAB_P2 = 5002;
const GITLAB_TWICE = 5003;

beforeAll(async () => {
  t = await createTestDb();
  [signer, stranger] = [await makeKey("k1"), await makeKey("k2")];
  const o1 = await createOrganization(t.db, { slug: "one", name: "One" });
  const o2 = await createOrganization(t.db, { slug: "two", name: "Two" });
  const p1 = await createProject(t.db, {
    organizationId: o1.id,
    name: "web",
    gitlabProjectId: GITLAB_P1,
  });
  const p2 = await createProject(t.db, {
    organizationId: o2.id,
    name: "api",
    gitlabProjectId: GITLAB_P2,
  });
  for (const [org, name] of [
    [o1, "twice-a"],
    [o2, "twice-b"],
  ] as const) {
    await createProject(t.db, { organizationId: org.id, name, gitlabProjectId: GITLAB_TWICE });
  }
  const env = (org: typeof o1, project: typeof p1, slug: string) =>
    createEnvironment(t.db, { organizationId: org.id, projectId: project.id, name: slug, slug });
  Object.assign(ids, {
    o1: o1.id,
    p1: p1.id,
    stagingP1: (await env(o1, p1, "staging")).id,
    productionP1: (await env(o1, p1, "production")).id,
    o2: o2.id,
    p2: p2.id,
    stagingP2: (await env(o2, p2, "staging")).id,
  });
  await env(o2, p2, "qa");
  app = makeApp(true);
});
afterAll(async () => {
  await t.drop();
});

const seconds = () => Date.now() / 1000;
const jobClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "project_path:acme/web:ref_type:branch:ref:main",
  iat: seconds() - 5,
  nbf: seconds() - 5,
  exp: seconds() + 300,
  project_id: String(GITLAB_P1),
  project_path: "acme/web",
  job_id: "777",
  ref: "main",
  ref_type: "branch",
  ref_protected: "true",
  ...over,
});
const idToken = (over: Record<string, unknown> = {}, by: Signer = signer) =>
  sign(by, jobClaims(over));

async function send(
  path: string,
  method = "GET",
  { bearer, body, app: target = app }: { bearer?: string; body?: unknown; app?: typeof app } = {},
) {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await target.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}
const exchange = (id_token: string, target = app) =>
  send("/auth/ci/exchange", "POST", { body: { id_token }, app: target });
const exchangeOk = async (over: Record<string, unknown> = {}) => {
  const res = await exchange(await idToken(over));
  expect(res.status).toBe(201);
  return res.json as { token: string; type: string; expiresAt: string; scopes: string[] };
};
const tokenRows = async () => (await t.db.select({ n: count() }).from(ciTokens))[0]?.n;
const exchangeEvents = () =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.ci_exchange"));

const project = (org = ids.o1, p = ids.p1) => `/organizations/${org}/projects/${p}`;
const envPath = (id: string) => `${project()}/environments/${id}`;

describe("a valid id_token", () => {
  test("becomes a token for the project, shown once and never cached", async () => {
    const before = await tokenRows();
    const res = await exchange(await idToken());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token, ...rest } = res.json;
    expect(isCiToken(token)).toBe(true);
    expect(rest).toMatchObject({ type: "Bearer", scopes: ["project.read"] });
    expect(await tokenRows()).toBe((before ?? 0) + 1);

    const [row] = await t.db
      .select()
      .from(ciTokens)
      .where(eq(ciTokens.tokenHash, hashToken(token)));
    expect(row).toMatchObject({
      organizationId: ids.o1,
      projectId: ids.p1,
      environmentId: null,
      gitlabProjectId: GITLAB_P1,
      gitlabJobId: 777,
      ref: "main",
      refProtected: true,
      scopes: ["project.read"],
    });
    expect(JSON.stringify(row)).not.toContain(token); // only the hash is kept
  });

  test("lasts 15 minutes at most, and never longer than the job's own token", async () => {
    const long = await exchangeOk({ exp: seconds() + 7200 });
    const minutes = (Date.parse(long.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThanOrEqual(15);

    const short = await exchangeOk({ exp: seconds() + 5 });
    const left = (Date.parse(short.expiresAt) - Date.now()) / 1000;
    expect(left).toBeGreaterThan(2);
    expect(left).toBeLessThanOrEqual(5);
  });

  test("is refused when the job's token ends within the clock skew we allow", async () => {
    const before = await tokenRows();
    const res = await exchange(await idToken({ exp: seconds() - 10 }));
    expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    expect(await tokenRows()).toBe(before);
  });

  test("a job id is optional", async () => {
    const { token } = await exchangeOk({ job_id: undefined });
    const [row] = await t.db
      .select()
      .from(ciTokens)
      .where(eq(ciTokens.tokenHash, hashToken(token)));
    expect(row?.gitlabJobId).toBeNull();
  });

  test("is recorded as the CI job, with no token in the record", async () => {
    const before = (await exchangeEvents()).length;
    const { token } = await exchangeOk({
      environment: "staging",
      environment_protected: "false",
      ref_protected: "false",
      ref: "feature",
    });
    const events = await exchangeEvents();
    expect(events).toHaveLength(before + 1);
    const event = events.at(-1);
    const [row] = await t.db
      .select()
      .from(ciTokens)
      .where(eq(ciTokens.tokenHash, hashToken(token)));
    expect(event).toMatchObject({
      actorKind: "ci",
      actorId: row?.id,
      resourceType: "ci_token",
      resourceId: row?.id,
      organizationId: ids.o1,
      projectId: ids.p1,
    });
    expect(event?.metadata).toMatchObject({
      gitlabProjectId: GITLAB_P1,
      ref: "feature",
      refProtected: false,
      environment: "staging",
      environmentId: ids.stagingP1,
    });
    expect(JSON.stringify(event)).not.toContain(token);
  });
});

describe("what a project token may do", () => {
  test("read its project, and nothing above or beside it", async () => {
    const { token } = await exchangeOk();
    const as = { bearer: token };
    expect((await send(project(), "GET", as)).status).toBe(200);
    expect((await send(project(ids.o1, ids.p2), "GET", as)).status).toBe(404);
    expect((await send(project(ids.o2, ids.p2), "GET", as)).status).toBe(404);
    // The guard trusts the path ids, so the queries must repeat both: the right project in the wrong org.
    expect((await send(project(ids.o2, ids.p1), "GET", as)).status).toBe(404);
    expect((await send(`/organizations/${ids.o1}`, "GET", as)).status).toBe(404);
    expect((await send("/organizations", "GET", as)).json.items).toEqual([]);
    // No environment was named, so none is readable.
    expect((await send(envPath(ids.stagingP1), "GET", as)).status).toBe(403);
    for (const [method, path, body] of [
      ["PATCH", project(), { name: "x" }],
      ["DELETE", project(), undefined],
      ["POST", `${project()}/environments`, { name: "N", slug: "n" }],
      ["POST", "/tokens", { name: "t", scopes: ["*"] }],
      ["GET", "/tokens", undefined],
    ] as const) {
      const res = await send(path, method, { ...as, body });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });
});

describe("what an environment token may do", () => {
  const staging = {
    environment: "staging",
    environment_protected: "false",
    ref_protected: "false",
    ref: "feature",
  };

  test("read its environment, not the others, and not a list of them", async () => {
    const { token, scopes } = await exchangeOk(staging);
    expect(scopes).toEqual(["project.read", "environment.read"]);
    const as = { bearer: token };
    expect((await send(project(), "GET", as)).status).toBe(200);
    expect((await send(envPath(ids.stagingP1), "GET", as)).status).toBe(200);
    expect((await send(envPath(ids.productionP1), "GET", as)).status).toBe(403);
    expect((await send(`${project()}/environments`, "GET", as)).status).toBe(403);
    const write = await send(envPath(ids.stagingP1), "PATCH", { ...as, body: { name: "x" } });
    expect(write.status).toBe(403);
    expect((await send(envPath(ids.stagingP1), "DELETE", as)).status).toBe(403);
  });

  test("a protected environment is reached from a protected ref", async () => {
    const { token } = await exchangeOk({
      environment: "production",
      environment_protected: "true",
      ref_protected: "true",
    });
    const as = { bearer: token };
    expect((await send(envPath(ids.productionP1), "GET", as)).status).toBe(200);
    expect((await send(envPath(ids.stagingP1), "GET", as)).status).toBe(403);
  });

  test("an unprotected ref does not reach a protected environment", async () => {
    const before = await tokenRows();
    const events = (await exchangeEvents()).length;
    const refused = [
      { environment: "production", environment_protected: "true", ref_protected: "false" },
      // GitLab did not say: treated as protected.
      { environment: "production", ref_protected: "false" },
      { environment: "production", environment_protected: "maybe", ref_protected: "true" },
    ];
    for (const over of refused.slice(0, 2)) {
      const res = await exchange(await idToken(over));
      expect([over, res.status, res.json.code]).toEqual([over, 403, "ref_not_protected"]);
    }
    // A claim we do not understand is not a token either.
    expect((await exchange(await idToken(refused[2]))).status).toBe(401);
    expect(await tokenRows()).toBe(before);
    expect(await exchangeEvents()).toHaveLength(events);
  });

  test("an unprotected environment is reached from any ref", async () => {
    await exchangeOk(staging);
  });

  test("an environment the project does not have is refused, also when another project has it", async () => {
    for (const environment of ["qa", "Staging", "nope"]) {
      const res = await exchange(
        await idToken({ environment, environment_protected: "false", ref_protected: "true" }),
      );
      expect([environment, res.status, res.json.code]).toEqual([
        environment,
        403,
        "environment_not_found",
      ]);
    }
  });

  test("another project's environment of the same name is not this one's", async () => {
    const { token } = await exchangeOk({
      project_id: String(GITLAB_P2),
      environment: "staging",
      environment_protected: "false",
    });
    const as = { bearer: token };
    expect(
      (await send(`${project(ids.o2, ids.p2)}/environments/${ids.stagingP2}`, "GET", as)).status,
    ).toBe(200);
    expect((await send(envPath(ids.stagingP1), "GET", as)).status).toBe(404);
    expect((await send(project(), "GET", as)).status).toBe(404);
  });
});

describe("what is refused", () => {
  const uniform = async (token: string) => {
    const before = await tokenRows();
    const events = (await exchangeEvents()).length;
    const res = await exchange(token);
    expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    expect(await tokenRows()).toBe(before);
    expect(await exchangeEvents()).toHaveLength(events);
    expect(res.text).not.toContain(token);
    return res.json.detail as string;
  };
  const reasons = () => lines.filter((l) => l.msg === "ci exchange refused").map((l) => l.reason);

  test("a token for another audience, issuer or key, and an expired or tampered one: one answer", async () => {
    const wrongAudience = await idToken({ aud: "somewhere.else" });
    const wrongIssuer = await idToken({ iss: "https://gitlab.evil.example.com" });
    const expired = await idToken({ exp: seconds() - 3600 });
    const notYet = await idToken({ nbf: seconds() + 3600 });
    const unknownKey = await idToken({}, { ...signer, kid: "unknown" });
    const notGitlabs = await sign({ ...stranger, kid: "k1" }, jobClaims()); // right kid, other key
    const [h, , s] = (await idToken()).split(".") as [string, string, string];
    const tampered = `${h}.${b64({ ...jobClaims(), project_id: String(GITLAB_P2) })}.${s}`;
    const none = await sign(signer, jobClaims(), { alg: "none" });
    const details = new Set<string>();
    for (const token of [
      wrongAudience,
      wrongIssuer,
      expired,
      notYet,
      unknownKey,
      notGitlabs,
      tampered,
      none,
      "x",
      "a.b.c",
      "",
    ]) {
      if (token === "") {
        expect((await exchange(token)).status).toBe(422);
        continue;
      }
      details.add(await uniform(token));
    }
    expect([...details]).toEqual(["The id_token is not valid"]);
    expect(reasons()).toEqual(
      expect.arrayContaining([
        "audience",
        "issuer",
        "expired",
        "not_yet_valid",
        "unknown_key",
        "signature",
        "algorithm",
        "malformed",
      ]),
    );
  });

  test("a token without the claims we need, or with them in the wrong form", async () => {
    for (const over of [
      { project_id: undefined },
      { project_id: "5001abc" },
      { project_id: 5001 },
      { project_id: "0" },
      { ref: undefined },
      { ref: "" },
      { ref_protected: undefined },
      { ref_protected: true },
      { ref_protected: "yes" },
      { job_id: "x" },
      { environment: "" },
    ]) {
      await uniform(await idToken(over));
    }
  });

  test("a project that is not registered, and one that is registered twice", async () => {
    const before = await tokenRows();
    const unknown = await exchange(await idToken({ project_id: "999999" }));
    expect([unknown.status, unknown.json.code]).toEqual([403, "project_not_registered"]);
    const twice = await exchange(await idToken({ project_id: String(GITLAB_TWICE) }));
    expect([twice.status, twice.json.code]).toEqual([409, "project_ambiguous"]);
    expect(await tokenRows()).toBe(before);
  });

  test("the body must be JSON with an id_token and nothing else", async () => {
    const good = await idToken();
    const post = (body: unknown) => send("/auth/ci/exchange", "POST", { body });
    expect((await post({})).status).toBe(422);
    expect((await post({ id_token: 5 })).status).toBe(422);
    expect((await post({ id_token: good, extra: 1 })).status).toBe(422);
    expect((await post({ id_token: "x".repeat(8193) })).status).toBe(422);
    const form = await app.handle(
      new Request("http://localhost/auth/ci/exchange", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `id_token=${good}`,
      }),
    );
    expect(form.status).toBe(415);
  });

  test("GitLab's keys not being reachable is 502, not a guess", async () => {
    keysDown = true;
    try {
      const res = await exchange(await idToken());
      expect([res.status, res.json.code]).toEqual([502, "gitlab_unavailable"]);
    } finally {
      keysDown = false;
    }
  });

  test("a lifetime outside one second to one hour is refused when the app is built", () => {
    const build = (ttlMs: number) =>
      createApp({
        logger,
        db: t.db,
        principal: callerPrincipal({ db: t.db }),
        ready: async () => {},
        ci: { key: async () => undefined, issuer: ISSUER, audience: AUDIENCE, ttlMs },
      });
    for (const ttlMs of [0, 999, 3_600_001, 1.5, Number.NaN]) {
      expect(() => build(ttlMs)).toThrow(TypeError);
    }
    expect(build(3_600_000)).toBeDefined();
  });

  test("without a configured audience the exchange is off", async () => {
    const res = await exchange(await idToken(), makeApp(false));
    expect([res.status, res.json.code]).toEqual([503, "ci_unavailable"]);
  });

  test("no log line carries a token or its claims", async () => {
    const token = await idToken({ aud: "somewhere.else" });
    await exchange(token);
    const all = JSON.stringify(lines);
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.split(".")[1] as string);
  });
});

describe("the issued token as a credential", () => {
  test("an unknown, expired or deleted token is nobody; the id_token itself is not a credential", async () => {
    const { token } = await exchangeOk();
    expect((await send(project(), "GET", { bearer: token })).status).toBe(200);

    const unknown = `orchci_${"A".repeat(8)}.${"B".repeat(43)}`;
    expect((await send(project(), "GET", { bearer: unknown })).status).toBe(401);
    expect((await send(project(), "GET", { bearer: await idToken() })).status).toBe(401);

    await t.db
      .update(ciTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(ciTokens.tokenHash, hashToken(token)));
    expect((await send(project(), "GET", { bearer: token })).status).toBe(401);
  });

  test("is the CI job: a reporter on its project, tied to its environment, and nobody else", async () => {
    const resolve = callerPrincipal({ db: t.db });
    const as = async (over: Record<string, unknown>) => {
      const { token } = await exchangeOk(over);
      const request = new Request("http://localhost/", {
        headers: { authorization: `Bearer ${token}` },
      });
      return resolve(request);
    };
    expect(await as({})).toMatchObject({
      kind: "ci",
      subject: {
        kind: "ci",
        orgRoles: {},
        projectRoles: { [ids.p1]: "reporter" },
        scopes: ["project.read"],
        environmentId: undefined,
      },
    });
    expect(await as({ environment: "staging", environment_protected: "false" })).toMatchObject({
      subject: {
        projectRoles: { [ids.p1]: "reporter" },
        scopes: ["project.read", "environment.read"],
        environmentId: ids.stagingP1,
      },
    });
  });

  test("goes with its project", async () => {
    const org = await createOrganization(t.db, { slug: "short-lived", name: "S" });
    const doomed = await createProject(t.db, {
      organizationId: org.id,
      name: "d",
      gitlabProjectId: 5100,
    });
    const { token } = await exchangeOk({ project_id: "5100" });
    const path = project(org.id, doomed.id);
    expect((await send(path, "GET", { bearer: token })).status).toBe(200);
    await deleteProject(t.db, org.id, doomed.id);
    expect((await send(path, "GET", { bearer: token })).status).toBe(401);
  });
});
