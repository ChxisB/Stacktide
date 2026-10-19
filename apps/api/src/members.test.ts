import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createOrganization,
  createSession,
  createSsoProvider,
  setSsoMembership,
  signInSso,
  updateSsoProvider,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
const NO_ORG = "00000000-0000-4000-8000-000000000000";

let t: TestDb;
let app: ReturnType<typeof createApp>;
let o1: string;
let o2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const cookies = {} as Record<"admin" | "owner" | "member" | "viewer" | "stranger", string>;
const members = {} as Record<"ada" | "bea" | "cy", { id: string }>;
const gitlabIds = {} as Record<keyof typeof cookies, number>;

async function provider(organizationId: string, enabled: boolean) {
  const made = await createSsoProvider(t.db, keys, {
    organizationId,
    issuer: `https://idp.example.com/realms/${organizationId}`,
    clientId: "orch",
    clientSecret: "idp-client-SECRET-CANARY-3318",
    emailDomains: ["acme.example"],
    roleMap: [{ claim: "groups", value: "all", role: "viewer" }],
  });
  if (enabled) await updateSsoProvider(t.db, keys, organizationId, { enabled });
  return made;
}
const join = async (providerId: string, username: string, role: "viewer" | "member" | "admin") => {
  const who = await signInSso(t.db, providerId, {
    subject: `sub-${username}`,
    email: `${username}@acme.example`,
    username,
    name: `${username.toUpperCase()} Person`,
  });
  await setSsoMembership(t.db, who.id, providerId, role, 3_600_000);
  return who;
};

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({
    logger: createLogger({ write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
  });
  o1 = (await createOrganization(t.db, { slug: "mem-one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "mem-two", name: "Two" })).id;
  let gitlabId = 700;
  for (const [name, role] of [
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
    ["viewer", "viewer"],
    ["stranger", undefined],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    cookies[name] = `orch_session=${session}`;
    gitlabIds[name] = gitlabId;
    roleTable.set(gitlabId, { orgRoles: role ? { [o1]: role } : {}, projectRoles: {} });
  }
  const [p1, p2] = [await provider(o1, true), await provider(o2, true)];
  members.cy = await join(p1.id, "cy", "admin");
  members.ada = await join(p1.id, "ada", "viewer");
  members.bea = await join(p1.id, "bea", "member");
  await join(p2.id, "eve", "admin"); // another organization's
});
afterAll(async () => {
  await t.drop();
});

async function list(who: keyof typeof cookies | undefined, org = o1, query = "") {
  const res = await app.handle(
    new Request(`http://localhost/organizations/${org}/members${query}`, {
      headers: who ? { cookie: cookies[who] } : {},
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

describe("GET /organizations/:orgId/members", () => {
  test("an admin or an owner reads who holds a role through the provider, by username", async () => {
    for (const who of ["admin", "owner"] as const) {
      const res = await list(who);
      expect(res.status).toBe(200);
      expect(
        res.json.items.map((m: { username: string; role: string }) => [m.username, m.role]),
      ).toEqual([
        ["ada", "viewer"],
        ["bea", "member"],
        ["cy", "admin"],
      ]);
      expect(res.json.nextCursor).toBeNull();
    }
  });

  test("a row says who and what, and nothing of how they sign in: no email, no subject", async () => {
    const [first] = (await list("admin")).json.items;
    expect(Object.keys(first).sort()).toEqual(["expiresAt", "id", "name", "role", "username"]);
    expect(first).toMatchObject({ id: members.ada.id, name: "ADA Person" });
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const text = (await list("admin")).text;
    expect(text).not.toContain("acme.example");
    expect(text).not.toContain("sub-ada");
  });

  test("it pages: a limit, and a cursor that continues after the last one", async () => {
    const one = await list("admin", o1, "?limit=2");
    expect(one.json.items.map((m: { username: string }) => m.username)).toEqual(["ada", "bea"]);
    expect(one.json.nextCursor).toBeString();
    const two = await list("admin", o1, `?limit=2&cursor=${one.json.nextCursor}`);
    expect(two.json.items.map((m: { username: string }) => m.username)).toEqual(["cy"]);
    expect(two.json.nextCursor).toBeNull();
    expect((await list("admin", o1, "?cursor=not-a-cursor")).status).toBe(400);
  });

  test("a member, a viewer and a stranger read nothing; nobody signed in is refused", async () => {
    expect((await list("member")).status).toBe(403);
    expect((await list("viewer")).status).toBe(403);
    expect((await list("stranger")).status).toBe(404); // holds no role there: the organization is not theirs to know of
    expect((await list(undefined)).status).toBe(401);
    expect((await list("admin", NO_ORG)).status).toBe(404);
  });

  test("an admin of another organization reads nothing of this one", async () => {
    // `boss` holds a role in o2 only: o1's members are not theirs
    const user = await upsertUser(t.db, { gitlabId: 799, username: "boss", name: "boss" });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    roleTable.set(799, { orgRoles: { [o2]: "owner" }, projectRoles: {} });
    const res = await app.handle(
      new Request(`http://localhost/organizations/${o1}/members`, {
        headers: { cookie: `orch_session=${session}` },
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.text()).includes("cy")).toBe(false);
  });

  test("a provider turned off lists nobody", async () => {
    const lone = (await createOrganization(t.db, { slug: "mem-off", name: "Off" })).id;
    const p = await provider(lone, false);
    await join(p.id, "dan", "admin");
    roleTable.set(gitlabIds.admin, {
      orgRoles: { [o1]: "admin", [lone]: "admin" },
      projectRoles: {},
    });
    const res = await list("admin", lone);
    expect([res.status, res.json.items]).toEqual([200, []]);
  });
});
