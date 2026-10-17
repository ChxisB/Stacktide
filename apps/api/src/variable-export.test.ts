// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newApiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;

let t: TestDb;
const lines: string[] = [];
const roleTable = new Map<number, Roles>();
const ids = {} as Record<"org" | "p1" | "p2" | "dev" | "prod" | "other", string>;
const cookies = {} as Record<"admin" | "maintainer" | "reporter" | "nobody", string>;
const userIds = {} as Record<keyof typeof cookies, string>;
const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme" })).id;
  const project = async (name: string) =>
    (await createProject(t.db, { organizationId: ids.org, name })).id;
  ids.p1 = await project("p1");
  ids.p2 = await project("p2");
  const env = async (projectId: string, slug: string) =>
    (await createEnvironment(t.db, { organizationId: ids.org, projectId, name: slug, slug })).id;
  ids.dev = await env(ids.p1, "dev");
  ids.prod = await env(ids.p1, "prod");
  ids.other = await env(ids.p2, "dev");
  let gitlabId = 700;
  for (const name of ["admin", "maintainer", "reporter", "nobody"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    cookies[name] = `orch_session=${session}`;
    userIds[name] = user.id;
  }
  roleTable.set(701, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(702, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  });
  roleTable.set(703, { orgRoles: { [ids.org]: "member" }, projectRoles: { [ids.p1]: "reporter" } });
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

const secrets: string[] = [];
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${Bun.randomUUIDv7()}`;
  secrets.push(marker);
  return marker;
};

async function call(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  application = app,
  headers: Record<string, string> = {},
) {
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
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

const org = `/organizations/${ids.org}`;
const set = async (at: "org" | "project" | "env", key: string, kind: string, value: string) => {
  const path =
    at === "org"
      ? `/organizations/${ids.org}/variables`
      : at === "project"
        ? `/organizations/${ids.org}/projects/${ids.p1}/variables`
        : `/organizations/${ids.org}/projects/${ids.p1}/environments/${ids.dev}/variables`;
  const res = await call(cookies.admin, "POST", path, { key, kind, value });
  expect(res.status).toBe(201);
};
const valuesPath = (env = ids.dev, project = ids.p1) =>
  `/organizations/${ids.org}/projects/${project}/environments/${env}/resolved-variables/values`;
const auditRows = () => t.db.select().from(auditEvents);

const dbPassword = sekrit("db-password");
const orgToken = sekrit("org-token");
const certificate = `-----BEGIN-----\n${sekrit("cert")}\n-----END-----`;

describe("GET .../resolved-variables/values", () => {
  beforeAll(async () => {
    await set("org", "REGION", "plain", "eu-west-1");
    await set("org", "ORG_TOKEN", "secret", orgToken);
    await set("project", "DB_USER", "plain", "app");
    await set("project", "DB_PASSWORD", "secret", "placeholder");
    await set("env", "DB_PASSWORD", "secret", dbPassword);
    // a plain value that reads a secret is itself a secret, and comes out interpolated
    await set("project", "DB_URL", "plain", "postgres://${DB_USER}:${DB_PASSWORD}@db/${REGION}");
    await set("env", "TLS_CERT", "file", certificate);
    await set("env", "MODE", "plain", "dev");
  });

  test("gives every value of the resolved set, secrets, files and what reads them included", async () => {
    const res = await call(cookies.maintainer, "GET", valuesPath());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.issues).toEqual([]);
    expect(res.json.variables).toEqual([
      { key: "DB_PASSWORD", kind: "secret", value: dbPassword },
      { key: "DB_URL", kind: "secret", value: `postgres://app:${dbPassword}@db/eu-west-1` },
      { key: "DB_USER", kind: "plain", value: "app" },
      { key: "MODE", kind: "plain", value: "dev" },
      { key: "ORG_TOKEN", kind: "secret", value: orgToken },
      { key: "REGION", kind: "plain", value: "eu-west-1" },
      { key: "TLS_CERT", kind: "file", value: certificate },
    ]);
  });

  test("another environment of the project sees its own set", async () => {
    const res = await call(cookies.maintainer, "GET", valuesPath(ids.prod));
    expect(res.status).toBe(200);
    expect(res.json.variables.map((v: { key: string }) => v.key)).toEqual([
      "DB_PASSWORD",
      "DB_URL",
      "DB_USER",
      "ORG_TOKEN",
      "REGION",
    ]);
    const password = res.json.variables.find((v: { key: string }) => v.key === "DB_PASSWORD");
    expect(password.value).toBe("placeholder");
  });

  test("is audited: a reveal for each secret or file, one row for the request, no value in any", async () => {
    const before = (await auditRows()).length;
    const res = await call(cookies.maintainer, "GET", valuesPath());
    expect(res.status).toBe(200);
    const rows = (await auditRows()).slice(before);
    const reveals = rows.filter((r) => r.action === "variable.reveal");
    expect(reveals.map((r) => (r.metadata as { key: string }).key).sort()).toEqual([
      "DB_PASSWORD",
      "DB_URL",
      "ORG_TOKEN",
      "TLS_CERT",
    ]);
    for (const r of reveals) {
      expect(r.actorId).toBe(userIds.maintainer);
      expect(r.metadata).toMatchObject({ environmentId: ids.dev, via: "export", version: 1 });
      expect(r.projectId).toBe(ids.p1);
    }
    const levels = Object.fromEntries(
      reveals.map((r) => [
        (r.metadata as { key: string }).key,
        (r.metadata as { level: string }).level,
      ]),
    );
    expect(levels).toEqual({
      DB_PASSWORD: "environment",
      DB_URL: "project",
      ORG_TOKEN: "organization",
      TLS_CERT: "environment",
    });
    const [summary, ...more] = rows.filter((r) => r.action === "variable.export");
    expect(more).toEqual([]);
    expect(summary?.resourceId).toBe(ids.dev);
    expect(summary?.metadata).toEqual({
      environmentId: ids.dev,
      count: 7,
      revealedCount: 4,
      issueCount: 0,
    });
    expect(rows).toHaveLength(5);
  });

  test("a reporter, who may list but not reveal, is refused and nothing is written", async () => {
    const before = (await auditRows()).length;
    const res = await call(cookies.reporter, "GET", valuesPath());
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(dbPassword);
    expect(await auditRows()).toHaveLength(before);
    // the listing they may read still holds the secrets back
    const listed = await call(cookies.reporter, "GET", valuesPath().replace(/\/values$/, ""));
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(dbPassword);
  });

  test("somebody with no role (who cannot see the project) and somebody not signed in are refused", async () => {
    expect((await call(cookies.nobody, "GET", valuesPath())).status).toBe(404);
    expect((await call(undefined, "GET", valuesPath())).status).toBe(401);
  });

  test("an environment that is not the project's, or does not exist, is not found", async () => {
    expect((await call(cookies.admin, "GET", valuesPath(ids.other))).status).toBe(404);
    const missing = await call(cookies.admin, "GET", valuesPath(crypto.randomUUID()));
    expect(missing.status).toBe(404);
    // an answer that fails is not cached either
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(
      (await call(cookies.admin, "GET", valuesPath(ids.dev, crypto.randomUUID()))).status,
    ).toBe(404);
  });

  test("a token needs the reveal in its scopes, not only the right to read", async () => {
    const bearer = async (scopes: string[]) => {
      const fresh = newApiToken();
      await createApiToken(t.db, {
        userId: userIds.admin,
        name: "t",
        prefix: fresh.prefix,
        tokenHash: fresh.tokenHash,
        scopes,
        ttlMs: 60_000,
      });
      return { authorization: `Bearer ${fresh.token}` };
    };
    const get = (headers: Record<string, string>) =>
      call(undefined, "GET", valuesPath(), undefined, app, headers);
    expect((await get(await bearer(["project.read", "variable.read"]))).status).toBe(403);
    expect((await get(await bearer(["project.read", "variable.*"]))).status).toBe(403);
    expect((await get(await bearer(["variable.read"]))).status).toBe(404);
    expect((await get(await bearer(["secret.reveal"]))).status).toBe(200);
  });

  test("a key that cannot be resolved is left out and explained by name, the rest comes", async () => {
    await set("env", "BROKEN", "plain", "x${NOT_THERE}y");
    const res = await call(cookies.admin, "GET", valuesPath());
    expect(res.status).toBe(200);
    expect(res.json.variables.map((v: { key: string }) => v.key)).not.toContain("BROKEN");
    expect(res.json.variables).toHaveLength(7);
    expect(res.json.issues).toEqual([{ code: "missing", key: "BROKEN", ref: "NOT_THERE" }]);
    const summary = (await auditRows()).filter((r) => r.action === "variable.export").at(-1);
    expect(summary?.metadata).toMatchObject({ count: 7, issueCount: 1 });
  });

  test("without master keys it answers 503, writes nothing and shows nothing", async () => {
    const before = (await auditRows()).length;
    const res = await call(cookies.admin, "GET", valuesPath(), undefined, makeApp(undefined));
    expect(res.status).toBe(503);
    expect(await auditRows()).toHaveLength(before);
  });

  test("the secrets are in these answers only: no audit row, log line or other answer holds one", async () => {
    for (const row of await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, ids.org))) {
      const text = JSON.stringify(row);
      for (const s of secrets) expect(text).not.toContain(s);
    }
    for (const s of secrets) expect(lines.join("\n")).not.toContain(s);
    const listed = await call(cookies.admin, "GET", valuesPath().replace(/\/values$/, ""));
    for (const s of secrets) expect(listed.text).not.toContain(s);
    expect(org.length).toBeGreaterThan(0);
  });
});
