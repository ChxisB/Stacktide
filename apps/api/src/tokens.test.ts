import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  apiTokens,
  auditEvents,
  createOrganization,
  createSession,
  sessions,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { devPrincipal } from "./principal";
import { hashToken, isApiToken, isCiToken, newApiToken, newCiToken, randomToken } from "./tokens";

describe("newCiToken", () => {
  test("is orchci_<id>.<secret> with the hash of the whole token, and not an API token", () => {
    const a = newCiToken();
    expect(isCiToken(a.token)).toBe(true);
    expect(isApiToken(a.token)).toBe(false);
    expect(isCiToken(newApiToken().token)).toBe(false);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.token.split(".")[1]).toHaveLength(43); // 256 bits
    expect(newCiToken().token).not.toBe(a.token);
  });

  test("only that shape is worth a lookup", () => {
    const { token } = newCiToken();
    for (const bad of ["", "x", `${token}x`, token.replace("orchci_", "orchcx_"), ` ${token}`]) {
      expect(isCiToken(bad)).toBe(false);
    }
  });
});

describe("newApiToken", () => {
  test("is orch_<id>.<secret> with the hash of the whole token and its own prefix", () => {
    const a = newApiToken();
    expect(isApiToken(a.token)).toBe(true);
    expect(a.token.startsWith(`${a.prefix}.`)).toBe(true);
    expect(a.prefix).toMatch(/^orch_[A-Za-z0-9_-]{8}$/);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.token.split(".")[1]).toHaveLength(43); // 256 bits
    expect(newApiToken().token).not.toBe(a.token);
  });

  test("only that shape is worth a lookup", () => {
    const { token, prefix } = newApiToken();
    for (const bad of [
      "",
      "x",
      prefix,
      `${token}x`,
      token.replace("orch_", "orcx_"),
      ` ${token}`,
    ]) {
      expect(isApiToken(bad)).toBe(false);
    }
  });
});

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let o1: string;
let o2: string;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol", { id: string; cookie: string }>;

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
      platformAdmins: [703], // carol
    }),
    ready: async () => {},
  });

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  let gitlabId = 700;
  for (const name of ["alice", "bob", "carol"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  const roles = (orgRoles: Roles["orgRoles"]) => ({ orgRoles, projectRoles: {} });
  roleTable.set(701, roles({ [o1]: "owner" })); // alice
  roleTable.set(702, roles({ [o1]: "viewer" })); // bob
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

type Auth = { cookie: string } | { bearer: string } | { raw: string } | undefined;
async function call(auth: Auth, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (auth && "cookie" in auth) headers.cookie = auth.cookie;
  if (auth && "bearer" in auth) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth && "raw" in auth) headers.authorization = auth.raw;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
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
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

async function mint(who: keyof typeof people, scopes: string[], extra: object = {}) {
  const res = await call(people[who], "POST", "/tokens", { name: "t", scopes, ...extra });
  expect(res.status).toBe(201);
  return res.json as { id: string; token: string; prefix: string };
}

describe("creating a token", () => {
  test("is shown once, expires in 30 days by default, and is never cached", async () => {
    const res = await call(people.alice, "POST", "/tokens", {
      name: "  deploy ",
      scopes: ["project.read", "project.read", "environment.*"],
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token, ...shown } = res.json;
    expect(isApiToken(token)).toBe(true);
    expect(shown).toMatchObject({
      name: "deploy",
      prefix: token.split(".")[0],
      scopes: ["project.read", "environment.*"],
      lastUsedAt: null,
      revokedAt: null,
    });
    const days = (Date.parse(shown.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  test("refuses what is not a name, a scope or a lifetime", async () => {
    const bad = [
      {},
      { name: "x" },
      { name: "x", scopes: [] },
      { name: "", scopes: ["project.read"] },
      { name: "x", scopes: ["project.reed"] },
      { name: "x", scopes: ["nothing.*"] },
      { name: "x", scopes: ["proj*"] },
      { name: "x", scopes: ["project.read"], expiresInDays: 0 },
      { name: "x", scopes: ["project.read"], expiresInDays: 366 },
      { name: "x", scopes: ["project.read"], expiresInDays: 1.5 },
      { name: "x", scopes: ["project.read"], userId: people.bob.id },
    ];
    for (const body of bad) {
      const res = await call(people.alice, "POST", "/tokens", body);
      expect([body, res.status, res.json.code]).toEqual([body, 422, "validation_failed"]);
    }
    const ok = await call(people.alice, "POST", "/tokens", {
      name: "x",
      scopes: ["*", "organization.*"],
      expiresInDays: 365,
    });
    expect(ok.status).toBe(201);
  });
});

describe("the plaintext", () => {
  test("is in the one response that created the token, and nowhere else", async () => {
    const { id, token } = await mint("alice", ["organization.read", "organization.update"]);
    const secret = token.split(".")[1] ?? "";
    // Use it, fail with it, change something with it, list it, revoke it.
    await call({ bearer: token }, "GET", "/organizations");
    await call({ bearer: token }, "PATCH", `/organizations/${o1}`, { name: "One" });
    await call({ bearer: `${token}x` }, "GET", "/organizations");
    const listed = await call(people.alice, "GET", "/tokens");
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    expect((await call(people.alice, "DELETE", `/tokens/${id}`)).status).toBe(204);
    await call({ bearer: token }, "GET", "/organizations");

    const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row?.tokenHash).toBe(hashToken(token));
    const everything = JSON.stringify([
      await t.db.select().from(apiTokens),
      await t.db.select().from(auditEvents),
      await t.db.select().from(sessions),
      lines,
    ]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(token);
    expect(lines.length).toBeGreaterThan(5); // the logs were really captured
  });

  test("the list shows what is needed to recognise a token and nothing that works as one", async () => {
    const { id, token } = await mint("bob", ["organization.read"]);
    const res = await call(people.bob, "GET", "/tokens");
    const item = res.json.items.find((i: { id: string }) => i.id === id);
    expect(Object.keys(item).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
      "revokedAt",
      "scopes",
    ]);
    expect(item.prefix).toBe(token.split(".")[0]);
  });
});

describe("using a token", () => {
  test("acts as its owner, narrowed to its scopes, and records the use", async () => {
    const { id, token } = await mint("alice", ["organization.read"]);
    const bearer = { bearer: token };
    const list = await call(bearer, "GET", "/organizations");
    expect(list.status).toBe(200);
    expect(list.json.items.map((o: { id: string }) => o.id)).toEqual([o1]);
    expect((await call(bearer, "GET", `/organizations/${o1}`)).status).toBe(200);
    // Alice may rename her organization; this token may not.
    const denied = await call(bearer, "PATCH", `/organizations/${o1}`, { name: "Renamed" });
    expect([denied.status, denied.json.code]).toEqual([403, "forbidden"]);
    // A scope it does not have hides what it cannot read.
    expect((await call(bearer, "GET", `/organizations/${o1}/projects`)).status).toBe(200);
    const onlyProjects = await mint("alice", ["project.read"]);
    expect((await call({ bearer: onlyProjects.token }, "GET", `/organizations/${o1}`)).status).toBe(
      404,
    );
    const mine = await call(people.alice, "GET", "/tokens");
    expect(mine.json.items.find((i: { id: string }) => i.id === id).lastUsedAt).not.toBeNull();
  });

  test("scopes never widen what the owner may do", async () => {
    const { token } = await mint("bob", ["*"]);
    const bearer = { bearer: token };
    expect((await call(bearer, "GET", `/organizations/${o1}`)).status).toBe(200);
    expect((await call(bearer, "PATCH", `/organizations/${o1}`, { name: "x" })).status).toBe(403);
    expect((await call(bearer, "GET", `/organizations/${o2}`)).status).toBe(404);
    const nobody = await mint("carol", ["*"]);
    expect((await call({ bearer: nobody.token }, "GET", `/organizations/${o1}`)).status).toBe(404);
    expect((await call({ bearer: nobody.token }, "GET", "/organizations")).json.items).toEqual([]);
  });

  test("a write by token is audited as the token", async () => {
    const { id, token } = await mint("alice", ["organization.update"]);
    const res = await call({ bearer: token }, "PATCH", `/organizations/${o1}`, { name: "One" });
    expect(res.status).toBe(200);
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "organization.update"));
    expect(events.at(-1)).toMatchObject({ actorKind: "token", actorId: id });
  });

  test("loses what its owner loses, as soon as the owner loses it", async () => {
    const { token } = await mint("alice", ["organization.read"]);
    expect((await call({ bearer: token }, "GET", `/organizations/${o1}`)).status).toBe(200);
    const roles = roleTable.get(701);
    roleTable.set(701, { orgRoles: {}, projectRoles: {} });
    try {
      expect((await call({ bearer: token }, "GET", `/organizations/${o1}`)).status).toBe(404);
    } finally {
      if (roles) roleTable.set(701, roles);
    }
  });

  test("is nobody when unknown, malformed, expired or revoked", async () => {
    const { id, token } = await mint("alice", ["organization.read"]);
    const [prefix, secret = ""] = token.split(".");
    const flipped = `${prefix}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    for (const bearer of [
      newApiToken().token,
      flipped,
      "nope",
      prefix ?? "",
      token.toUpperCase(),
    ]) {
      const res = await call({ bearer }, "GET", "/organizations");
      expect([bearer === token, res.status, res.json.code]).toEqual([
        false,
        401,
        "unauthenticated",
      ]);
    }
    expect((await call({ bearer: token }, "GET", "/organizations")).status).toBe(200);

    await t.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, id));
    expect((await call({ bearer: token }, "GET", "/organizations")).status).toBe(401);

    const second = await mint("alice", ["organization.read"]);
    expect((await call({ bearer: second.token }, "GET", "/organizations")).status).toBe(200);
    await call(people.alice, "DELETE", `/tokens/${second.id}`);
    expect((await call({ bearer: second.token }, "GET", "/organizations")).status).toBe(401);
  });

  test("a token that is ours but no good is nobody; a header that is not ours is ignored", async () => {
    const send = (raw: string, cookie?: string) =>
      app.handle(
        new Request("http://localhost/organizations", {
          headers: { authorization: raw, ...(cookie ? { cookie } : {}) },
        }),
      );
    const mine = people.alice.cookie;
    // Shaped like one of our tokens: it alone decides, the cookie is not consulted.
    expect((await send(`Bearer ${newApiToken().token}`, mine)).status).toBe(401);
    // Not ours (a proxy's Basic auth, another bearer scheme): as if absent.
    for (const raw of ["Basic YWxpY2U6cHc=", "Bearer", "Bearer abc", "Token xyz"]) {
      expect([raw, (await send(raw)).status]).toEqual([raw, 401]);
      expect([raw, (await send(raw, mine)).status]).toEqual([raw, 200]);
    }
    expect((await call(people.alice, "GET", "/organizations")).status).toBe(200);
    // The scheme is part of the header, and its case does not matter.
    const { token } = await mint("alice", ["organization.read"]);
    expect((await send(`bearer ${token}`)).status).toBe(200);
    for (const raw of [token, `Basic ${token}`, `Token ${token}`]) {
      expect([raw === token, (await send(raw)).status]).toEqual([raw === token, 401]);
    }
  });

  test("a platform admin's token may create organizations only with that scope", async () => {
    const body = { slug: "from-token", name: "From token" };
    const may = await mint("carol", ["organization.create"]);
    const created = await call({ bearer: may.token }, "POST", "/organizations", body);
    expect(created.status).toBe(201);
    const without = await mint("carol", ["organization.read"]);
    expect((await call({ bearer: without.token }, "POST", "/organizations", body)).status).toBe(
      403,
    );
    // Not an admin: the scope alone grants nothing.
    const bob = await mint("bob", ["*"]);
    expect((await call({ bearer: bob.token }, "POST", "/organizations", body)).status).toBe(403);
  });
});

describe("managing tokens", () => {
  test("needs a signed-in user: a token, even with every scope, cannot mint or revoke tokens", async () => {
    const { id, token } = await mint("alice", ["*"]);
    const bearer = { bearer: token };
    for (const [method, path, body] of [
      ["GET", "/tokens"],
      ["POST", "/tokens", { name: "x", scopes: ["*"] }],
      ["DELETE", `/tokens/${id}`],
    ] as const) {
      const res = await call(bearer, method, path, body);
      expect([method, res.status, res.json.code]).toEqual([method, 403, "forbidden"]);
    }
    expect(
      (await call(people.alice, "GET", "/tokens")).json.items.some(
        (i: { id: string }) => i.id === id,
      ),
    ).toBe(true);
  });

  test("nobody is not a user either", async () => {
    for (const [method, path, body] of [
      ["GET", "/tokens"],
      ["POST", "/tokens", { name: "x", scopes: ["*"] }],
      ["DELETE", `/tokens/${crypto.randomUUID()}`],
    ] as const) {
      expect((await call(undefined, method, path, body)).status).toBe(401);
    }
  });

  test("the dev principal has no account to own a token", async () => {
    const dev = createApp({
      logger: createLogger({ write: () => {} }),
      db: t.db,
      principal: devPrincipal,
      ready: async () => {},
    });
    const res = await dev.handle(new Request("http://localhost/tokens"));
    expect(res.status).toBe(403);
  });

  test("each user sees and revokes only their own", async () => {
    const mine = await mint("alice", ["organization.read"]);
    const theirs = await mint("bob", ["organization.read"]);
    const seen = async (who: keyof typeof people) =>
      (await call(people[who], "GET", "/tokens?limit=100")).json.items.map(
        (i: { id: string }) => i.id,
      );
    expect(await seen("alice")).toContain(mine.id);
    expect(await seen("alice")).not.toContain(theirs.id);
    expect(await seen("bob")).not.toContain(mine.id);

    const before = await t.db.select().from(auditEvents);
    for (const id of [mine.id, crypto.randomUUID()]) {
      const res = await call(people.bob, "DELETE", `/tokens/${id}`);
      expect([res.status, res.json.code]).toEqual([404, "not_found"]);
    }
    expect(await t.db.select().from(auditEvents)).toHaveLength(before.length);
    expect((await call({ bearer: mine.token }, "GET", "/organizations")).status).toBe(200);
  });

  test("revoking is audited, keeps the row in the list, and a second revoke finds nothing", async () => {
    const { id, prefix } = await mint("alice", ["organization.read"]);
    expect((await call(people.alice, "DELETE", `/tokens/${id}`)).status).toBe(204);
    expect((await call(people.alice, "DELETE", `/tokens/${id}`)).status).toBe(404);
    const item = (await call(people.alice, "GET", "/tokens?limit=100")).json.items.find(
      (i: { id: string }) => i.id === id,
    );
    expect(item.revokedAt).not.toBeNull();
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    expect(events.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([
      ["token.create", "user", people.alice.id],
      ["token.revoke", "user", people.alice.id],
    ]);
    expect(events[0]?.metadata).toMatchObject({ prefix, scopes: ["organization.read"] });
  });

  test("the list pages through all of the caller's tokens", async () => {
    for (let i = 0; i < 3; i++) await mint("carol", ["organization.read"]);
    const ids = (r: { json: { items: { id: string }[] } }) => r.json.items.map((x) => x.id);
    const all = ids(await call(people.carol, "GET", "/tokens?limit=100"));
    expect(all.length).toBeGreaterThanOrEqual(3);
    const walked: string[] = [];
    let cursor = "";
    for (let page = 0; page <= all.length; page++) {
      const res = await call(people.carol, "GET", `/tokens?limit=2${cursor}`);
      expect(res.json.items.length).toBeLessThanOrEqual(2);
      walked.push(...ids(res));
      if (res.json.nextCursor === null) break;
      cursor = `&cursor=${res.json.nextCursor}`;
    }
    expect(walked).toEqual(all);
  });
});
