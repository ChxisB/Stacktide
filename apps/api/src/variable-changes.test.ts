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
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newApiToken, randomToken } from "./tokens";

// VWS-9: the project's changes feed lists who wrote which version of which variable, and never a value.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;

let t: TestDb;
const lines: string[] = [];
const roleTable = new Map<number, Roles>();
const ids = {} as Record<"org" | "p1" | "p2" | "dev" | "prod" | "other", string>;
const cookies = {} as Record<"admin" | "maintainer" | "reporter" | "nobody", string>;
const userIds = {} as Record<keyof typeof cookies, string>;
let app: ReturnType<typeof createApp>;

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
  let gitlabId = 800;
  for (const name of ["admin", "maintainer", "reporter", "nobody"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    cookies[name] = `orch_session=${session}`;
    userIds[name] = user.id;
  }
  roleTable.set(801, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(802, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  });
  roleTable.set(803, { orgRoles: { [ids.org]: "member" }, projectRoles: { [ids.p1]: "reporter" } });
  app = createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });
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
const bodies: string[] = [];

async function call(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // only the feed's answers: a write answers with the plain value it was given
  if (path.includes("/variable-changes")) bodies.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const levelPath = (at: "org" | "project" | "env", project = ids.p1, env = ids.dev) =>
  at === "org"
    ? `/organizations/${ids.org}/variables`
    : at === "project"
      ? `/organizations/${ids.org}/projects/${project}/variables`
      : `/organizations/${ids.org}/projects/${project}/environments/${env}/variables`;
const make = async (
  at: "org" | "project" | "env",
  key: string,
  kind: string,
  value: string,
  where: { project?: string; env?: string } = {},
) => {
  const res = await call(cookies.admin, "POST", levelPath(at, where.project, where.env), {
    key,
    kind,
    value,
  });
  expect(res.status).toBe(201);
  return res.json.id as string;
};
const change = async (
  at: "org" | "project" | "env",
  id: string,
  value: string,
  reason?: string,
  who: keyof typeof cookies = "admin",
) => {
  const res = await call(cookies[who], "PATCH", `${levelPath(at)}/${id}`, {
    value,
    ...(reason ? { reason } : {}),
  });
  expect(res.status).toBe(200);
};
const feed = (project = ids.p1, query = "") =>
  `/organizations/${ids.org}/projects/${project}/variable-changes${query}`;
type Row = { key: string; version: number } & Record<string, unknown>;
const label = (r: Row) => `${r.key}@${r.version}`;
const labels = (json: { items: Row[] }) => json.items.map(label);

const password = sekrit("db-password");
const newer = sekrit("db-password-2");
const foreign = sekrit("foreign");
const orgSecret = sekrit("org-secret");
const plainOne = "PLAIN-VALUE-one";
const plainTwo = "PLAIN-VALUE-two";

describe("GET /organizations/:orgId/projects/:projectId/variable-changes", () => {
  beforeAll(async () => {
    const region = await make("project", "REGION", "plain", plainOne);
    const dbPassword = await make("env", "DB_PASSWORD", "secret", password);
    await make("project", "MODE", "plain", "fast");
    await change("project", region, plainTwo, "moved to a new region");
    await change("env", dbPassword, newer, undefined, "maintainer");
    await make("env", "PROD_ONLY", "plain", "x", { env: ids.prod });
    await make("org", "ORG_TOKEN", "secret", orgSecret);
    await make("project", "FOREIGN", "secret", foreign, { project: ids.p2 });
    await make("env", "FOREIGN_ENV", "plain", "x", { project: ids.p2, env: ids.other });
  });

  test("one row for each version written to the project and its environments, newest first", async () => {
    const res = await call(cookies.reporter, "GET", feed());
    expect(res.status).toBe(200);
    expect(labels(res.json)).toEqual([
      "PROD_ONLY@1",
      "DB_PASSWORD@2",
      "REGION@2",
      "MODE@1",
      "DB_PASSWORD@1",
      "REGION@1",
    ]);
    expect(res.json.nextCursor).toBeNull();
  });

  test("each row says what changed, where, by whom, when and why", async () => {
    const res = await call(cookies.reporter, "GET", feed());
    const row = (l: string) => res.json.items.find((r: Row) => label(r) === l);
    expect(Object.keys(row("REGION@2")).sort()).toEqual(
      [
        "actorId",
        "actorKind",
        "createdAt",
        "environmentId",
        "folder",
        "id",
        "key",
        "kind",
        "level",
        "reason",
        "variableId",
        "version",
      ].sort(),
    );
    expect(row("REGION@2")).toMatchObject({
      kind: "plain",
      level: "project",
      environmentId: null,
      actorKind: "user",
      actorId: userIds.admin,
      reason: "moved to a new region",
    });
    expect(row("DB_PASSWORD@2")).toMatchObject({
      kind: "secret",
      level: "environment",
      environmentId: ids.dev,
      actorId: userIds.maintainer,
      reason: null,
    });
    expect(Number.isNaN(Date.parse(row("REGION@2").createdAt))).toBe(false);
  });

  test("a page ends with a cursor that continues it; the last page has none", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        cookies.reporter,
        "GET",
        feed(ids.p1, `?limit=4${cursor ? `&cursor=${cursor}` : ""}`),
      );
      expect(res.status).toBe(200);
      pages += 1;
      seen.push(...labels(res.json));
      cursor = res.json.nextCursor;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toEqual([
      "PROD_ONLY@1",
      "DB_PASSWORD@2",
      "REGION@2",
      "MODE@1",
      "DB_PASSWORD@1",
      "REGION@1",
    ]);
  });

  test("an exact page has no cursor, and a bad one is refused", async () => {
    const exact = await call(cookies.reporter, "GET", feed(ids.p1, "?limit=6"));
    expect([exact.json.items.length, exact.json.nextCursor]).toEqual([6, null]);
    const bad = await call(cookies.reporter, "GET", feed(ids.p1, "?cursor=not-a-cursor"));
    expect([bad.status, bad.json.code]).toEqual([400, "invalid_cursor"]);
    const wrong = await call(
      cookies.reporter,
      "GET",
      feed(ids.p1, `?cursor=${Buffer.from(JSON.stringify([42])).toString("base64url")}`),
    );
    expect([wrong.status, wrong.json.code]).toEqual([400, "invalid_cursor"]);
  });

  test("an environment sees the project's changes and its own, not a sibling's", async () => {
    const dev = await call(cookies.reporter, "GET", feed(ids.p1, `?environmentId=${ids.dev}`));
    expect(labels(dev.json)).toEqual([
      "DB_PASSWORD@2",
      "REGION@2",
      "MODE@1",
      "DB_PASSWORD@1",
      "REGION@1",
    ]);
    const prod = await call(cookies.reporter, "GET", feed(ids.p1, `?environmentId=${ids.prod}`));
    expect(labels(prod.json)).toEqual(["PROD_ONLY@1", "REGION@2", "MODE@1", "REGION@1"]);
  });

  test("an environment of another project is not found, and nor is one that does not exist", async () => {
    for (const environmentId of [ids.other, crypto.randomUUID()]) {
      const res = await call(
        cookies.reporter,
        "GET",
        feed(ids.p1, `?environmentId=${environmentId}`),
      );
      expect([res.status, res.json.code]).toEqual([404, "not_found"]);
    }
    const bad = await call(cookies.reporter, "GET", feed(ids.p1, "?environmentId=nope"));
    expect(bad.status).toBe(422);
  });

  test("another project's changes and the organization's never appear, and a project that is not here is not found", async () => {
    const own = await call(cookies.admin, "GET", feed());
    const keysOf = own.json.items.map((r: Row) => r.key);
    for (const other of ["FOREIGN", "FOREIGN_ENV", "ORG_TOKEN"])
      expect(keysOf).not.toContain(other);
    const second = await call(cookies.admin, "GET", feed(ids.p2));
    expect(second.json.items.map((r: Row) => r.key)).toEqual(["FOREIGN_ENV", "FOREIGN"]);
    const missing = await call(cookies.admin, "GET", feed(crypto.randomUUID()));
    expect([missing.status, missing.json.code]).toEqual([404, "not_found"]);
  });

  test("a deleted variable's changes go with it", async () => {
    const id = await make("project", "SHORT_LIVED", "plain", "x");
    expect(labels((await call(cookies.admin, "GET", feed())).json)[0]).toBe("SHORT_LIVED@1");
    const gone = await call(cookies.admin, "DELETE", `${levelPath("project")}/${id}`);
    expect(gone.status).toBe(204);
    expect(labels((await call(cookies.admin, "GET", feed())).json)).not.toContain("SHORT_LIVED@1");
  });

  test("the lowest project role reads it; no session is 401; no role in the project is 404", async () => {
    for (const who of ["reporter", "maintainer", "admin"] as const) {
      expect([who, (await call(cookies[who], "GET", feed())).status]).toEqual([who, 200]);
    }
    const anonymous = await call(undefined, "GET", feed());
    expect([anonymous.status, anonymous.json.code]).toEqual([401, "unauthenticated"]);
    // the guard does not tell a caller who cannot see the project that it exists
    const hidden = await call(cookies.nobody, "GET", feed());
    expect([hidden.status, hidden.json.code]).toEqual([404, "not_found"]);
    expect(hidden.text).not.toContain("DB_PASSWORD");
  });

  test("a token whose scopes leave out variable.read is refused with 403", async () => {
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
    const get = async (scopes: string[]) =>
      call(undefined, "GET", feed(), undefined, await bearer(scopes));
    const denied = await get(["project.read"]);
    expect([denied.status, denied.json.code]).toEqual([403, "forbidden"]);
    expect(denied.text).not.toContain("DB_PASSWORD");
    expect((await get(["project.read", "variable.read"])).status).toBe(200);
  });

  test("it writes no audit row: a read of names, versions and people", async () => {
    const before = (await t.db.select().from(auditEvents)).length;
    await call(cookies.reporter, "GET", feed());
    await call(cookies.reporter, "GET", feed(ids.p1, `?environmentId=${ids.dev}`));
    expect((await t.db.select().from(auditEvents)).length).toBe(before);
  });

  test("no secret, plain value or file value is in any answer or any log line", async () => {
    // every answer above and these: with the values of the project in the store
    for (const query of ["", `?environmentId=${ids.dev}`, "?limit=1"]) {
      await call(cookies.admin, "GET", feed(ids.p1, query));
      await call(cookies.admin, "GET", feed(ids.p2, query));
    }
    const everything = bodies.join("\n");
    for (const value of [...secrets, plainOne, plainTwo]) {
      expect(everything).not.toContain(value);
      expect(lines.join("\n")).not.toContain(value);
    }
  });
});
