import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import type { Hardening } from "./hardening";
import { devPrincipal } from "./principal";
import { LIMITS, type LimitClass } from "./rate-limit";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const METRICS = "m".repeat(40);
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;

let t: TestDb;
const roleTable = new Map<number, Roles>();
const ids = {} as Record<"org" | "project" | "env", string>;
const cookies = {} as Record<"admin" | "other" | "reporter", string>;
const lines: Record<string, unknown>[] = [];

const makeApp = (hardening: Partial<Hardening> = {}, dev = false) =>
  createApp({
    logger: createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l)) }),
    db: t.db,
    principal: dev
      ? devPrincipal
      : callerPrincipal({
          db: t.db,
          roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
        }),
    ready: async () => {},
    keys,
    metrics: { token: METRICS, stats: async () => ({ jobs: [], syncRuns: [], stackRuns: [] }) },
    hardening: { rateLimitScale: 0.1, ...hardening },
  });

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme" })).id;
  ids.project = (await createProject(t.db, { organizationId: ids.org, name: "p" })).id;
  ids.env = (
    await createEnvironment(t.db, {
      organizationId: ids.org,
      projectId: ids.project,
      name: "dev",
      slug: "dev",
    })
  ).id;
  let gitlabId = 900;
  for (const name of ["admin", "other", "reporter"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    cookies[name] = `orch_session=${session}`;
  }
  roleTable.set(901, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(902, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(903, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.project]: "reporter" },
  });
});
afterAll(async () => {
  await t.drop();
});

type App = ReturnType<typeof makeApp>;
async function call(
  app: App,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const allowed = (cls: LimitClass, scale = 0.1) => Math.max(1, Math.floor(LIMITS[cls].max * scale));
const statuses = async (n: number, one: () => Promise<{ status: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await one()).status);
  return out;
};
const firstRefusal = (s: number[]) => s.indexOf(429);

describe("a refusal", () => {
  test("is a 429 problem that says when to come back, names no limit and no address", async () => {
    const app = makeApp();
    const sent = allowed("login");
    for (let i = 0; i < sent; i++) await call(app, "GET", "/auth/login");
    const res = await call(app, "GET", "/auth/login", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({
      status: 429,
      code: "rate_limited",
      title: "Too Many Requests",
    });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(
      LIMITS.login.windowMs / 1000,
    );
    expect(res.headers.get("x-request-id")).toBe(res.json.request_id);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.stringify(res.json)).not.toMatch(/login|9\.9\.9\.9|unknown/);
    const logged = lines.filter((l) => l.msg === "rate limited");
    expect(logged.at(-1)).toMatchObject({ limit: "login", by: "ip" });
    expect(JSON.stringify(logged)).not.toContain("9.9.9.9");
  });

  test("is counted in the metrics by the limit it hit, and in no other way", async () => {
    const app = makeApp();
    for (let i = 0; i < allowed("login") + 2; i++) await call(app, "GET", "/auth/login");
    const res = await app.handle(
      new Request("http://localhost/metrics", { headers: { authorization: `Bearer ${METRICS}` } }),
    );
    expect(res.status).toBe(200); // /metrics is not limited
    const text = await res.text();
    expect(text).toContain('orch_rate_limited_total{limit="login"} 2');
    expect(text).not.toContain('limit="reveal"');
  });
});

describe("the sign-in and the exchanges count the client's address", () => {
  test("login: the first requests pass (503: sign-in is not set up here), then 429", async () => {
    const app = makeApp();
    const s = await statuses(allowed("login") + 2, () => call(app, "GET", "/auth/login"));
    expect(s).toEqual([...Array(allowed("login")).fill(503), 429, 429]);
  });

  test("the CLI's login and code exchange share the login limit with the browser's", async () => {
    const app = makeApp();
    const n = allowed("login");
    for (let i = 0; i < n; i++) await call(app, "GET", "/auth/login");
    expect((await call(app, "GET", "/auth/cli")).status).toBe(429);
    const exchange = await call(app, "POST", "/auth/cli/token", { body: { code: "x" } });
    expect(exchange.status).toBe(429);
    // a different class is untouched
    expect((await call(app, "GET", "/health")).status).toBe(200);
  });

  test("a request that is refused never reaches the handler or its validation", async () => {
    const app = makeApp();
    for (let i = 0; i < allowed("login"); i++) await call(app, "GET", "/auth/login");
    const res = await call(app, "GET", "/auth/login?return_to=" + "x".repeat(600));
    expect(res.status).toBe(429); // not the 422 that return_to > 500 would give
  });

  test("with no proxy in front, X-Forwarded-For is ignored: a client cannot pick its own bucket", async () => {
    const app = makeApp();
    const s = await statuses(
      allowed("login") + 2,
      (() => {
        let i = 0;
        return () =>
          call(app, "GET", "/auth/login", { headers: { "x-forwarded-for": `1.1.1.${++i}` } });
      })(),
    );
    expect(firstRefusal(s)).toBe(allowed("login"));
  });

  test("a header the settings cannot use is logged once, so a mistaken proxy count is found", async () => {
    const said = () => lines.filter((l) => String(l.msg).includes("X-Forwarded-For"));
    const before = said().length;
    const none = makeApp();
    await call(none, "GET", "/auth/login", { headers: { "x-forwarded-for": "198.51.100.7" } });
    await call(none, "GET", "/auth/login", { headers: { "x-forwarded-for": "198.51.100.8" } });
    expect(said()).toHaveLength(before + 1);
    expect(said().at(-1)).toMatchObject({ level: "warn" });
    expect(JSON.stringify(said())).not.toContain("198.51.100");
  });

  test("behind one proxy each client address has its own count, and a forged entry does not help", async () => {
    const app = makeApp({ proxyHops: 1 });
    const from =
      (client: string, forged = "7.7.7.7") =>
      () =>
        call(app, "GET", "/auth/login", { headers: { "x-forwarded-for": `${forged}, ${client}` } });
    const a = await statuses(allowed("login") + 1, from("203.0.113.1"));
    expect(firstRefusal(a)).toBe(allowed("login"));
    // the same client with a different forged first entry is still the same client
    expect((await from("203.0.113.1", "8.8.8.8")()).status).toBe(429);
    // another client is fresh
    expect((await from("203.0.113.2")()).status).toBe(503);
  });

  test("the CI exchange and the webhook have their own counts", async () => {
    const app = makeApp();
    const ci = await statuses(allowed("ci_exchange") + 1, () =>
      call(app, "POST", "/auth/ci/exchange", { body: { id_token: "x" } }),
    );
    expect(firstRefusal(ci)).toBe(allowed("ci_exchange"));
    expect(ci.slice(0, -1).every((s) => s !== 429)).toBe(true);

    const unknown = "00000000-0000-4000-8000-000000000000";
    const hook = await statuses(allowed("webhook") + 1, () =>
      call(app, "POST", `/webhooks/gitlab/${unknown}`, {
        body: {},
        headers: { "x-gitlab-token": "wrong" },
      }),
    );
    expect(firstRefusal(hook)).toBe(allowed("webhook"));
    expect(hook.slice(0, -1).every((s) => s === 401 || s === 404)).toBe(true);
    // the login count was not used by either
    expect((await call(app, "GET", "/auth/login")).status).toBe(503);
  });
});

describe("what a person can do is counted for the person", () => {
  test("creating tokens: one more than allowed is refused, for that person only", async () => {
    const app = makeApp();
    const mint = (cookie: string) => () =>
      call(app, "POST", "/tokens", { cookie, body: { name: "t", scopes: ["project.read"] } });
    const mine = await statuses(allowed("token_create") + 1, mint(cookies.admin));
    expect(mine).toEqual([...Array(allowed("token_create")).fill(201), 429]);
    expect((await mint(cookies.other)()).status).toBe(201);
  });

  test("the same person from many addresses is still one person", async () => {
    const app = makeApp({ proxyHops: 1 });
    const mint = (ip: string) => () =>
      call(app, "POST", "/tokens", {
        cookie: cookies.admin,
        body: { name: "t", scopes: ["project.read"] },
        headers: { "x-forwarded-for": ip },
      });
    const s = await statuses(
      allowed("token_create") + 1,
      (() => {
        let i = 0;
        return () => mint(`203.0.113.${++i}`)();
      })(),
    );
    expect(firstRefusal(s)).toBe(allowed("token_create"));
  });

  test("a token of the person is the person: it shares the count, and is not a second allowance", async () => {
    const app = makeApp();
    const made = await call(app, "POST", "/tokens", {
      cookie: cookies.admin,
      body: { name: "t", scopes: ["project.read"] },
    });
    expect(made.status).toBe(201);
    const bearer = { authorization: `Bearer ${made.json.token}` };
    // the person has used the allowance; the token, which would be refused anyway, is counted as them
    const again = await call(app, "POST", "/tokens", {
      body: { name: "t", scopes: ["project.read"] },
      headers: bearer,
    });
    expect(again.status).toBe(429);
  });

  describe("revealing", () => {
    const varsPath = `/organizations/${ids.org}/projects/${ids.project}/environments/${ids.env}`;
    let reveal: string;
    let revealAll: string;
    beforeAll(async () => {
      const path = `/organizations/${ids.org}/projects/${ids.project}/environments/${ids.env}`;
      const made = await call(makeApp(), "POST", `${path}/variables`, {
        cookie: cookies.admin,
        body: { key: "DB_PASSWORD", kind: "secret", value: "limits-test-value" },
      });
      expect(made.status).toBe(201);
      reveal = `${path}/variables/${made.json.id}/value`;
      revealAll = `${path}/resolved-variables/values`;
    });

    test("one secret: past the limit the value is no longer given, however many routes are used", async () => {
      const app = makeApp();
      const n = allowed("reveal");
      const s = await statuses(n + 1, () => call(app, "GET", reveal, { cookie: cookies.admin }));
      expect(s).toEqual([...Array(n).fill(200), 429]);
      const refused = await call(app, "GET", reveal, { cookie: cookies.admin });
      expect(JSON.stringify(refused.json)).not.toContain("limits-test-value");
      // the reveal of a whole environment is the same count
      expect((await call(app, "GET", revealAll, { cookie: cookies.admin })).status).toBe(429);
      // another person has theirs
      expect((await call(app, "GET", reveal, { cookie: cookies.other })).status).toBe(200);
    });

    test("a whole environment counts like a single secret", async () => {
      const app = makeApp();
      const n = allowed("reveal");
      const s = await statuses(n + 1, () => call(app, "GET", revealAll, { cookie: cookies.admin }));
      expect(s).toEqual([...Array(n).fill(200), 429]);
      expect((await call(app, "GET", reveal, { cookie: cookies.admin })).status).toBe(429);
    });

    test("someone who may not reveal is counted too, so guessing at ids is limited", async () => {
      const app = makeApp();
      const n = allowed("reveal");
      const s = await statuses(n + 1, () => call(app, "GET", reveal, { cookie: cookies.reporter }));
      expect(s).toEqual([...Array(n).fill(403), 429]);
    });
    void varsPath;
  });
});

describe("the local-development principal", () => {
  test("is not a client to count: it is never refused", async () => {
    const app = makeApp({}, true);
    const s = await statuses(allowed("login") + allowed("reveal") + 5, () =>
      call(app, "POST", "/tokens", { body: { name: "t", scopes: ["project.read"] } }),
    );
    expect(s).not.toContain(429);
    // but it is the signed-out caller of a public route that is counted by address
    const login = await statuses(allowed("login") + 1, () => call(app, "GET", "/auth/login"));
    expect(login).not.toContain(429);
  });
});
