import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createOrganization,
  createSession,
  getSecretGate,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let o1: string;
let o2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"owner" | "admin" | "member" | "viewer" | "outsider" | "boss", string>;

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
  let gitlabId = 700;
  for (const [name, org, role] of [
    ["owner", o1, "owner"],
    ["admin", o1, "admin"],
    ["member", o1, "member"],
    ["viewer", o1, "viewer"],
    ["outsider", o2, "admin"],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    roleTable.set(gitlabId, { orgRoles: { [org]: role }, projectRoles: {} });
  }
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who];
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
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const gate = (org = o1) => `/organizations/${org}/secret-gate`;
const auditsOf = async (action: string) =>
  await t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, o1)));
const NO_ORG = "00000000-0000-4000-8000-000000000000";

describe("an organization's secret gate (SCAN-6)", () => {
  test("is off until an org admin sets it, and anyone in the organization reads it", async () => {
    for (const who of ["owner", "admin", "member", "viewer"] as const) {
      const res = await call(who, "GET", gate());
      expect([who, res.status, res.json]).toEqual([who, 200, { gate: "off" }]);
    }
  });

  test("an org admin sets warn, deny and off again; the answer, the read and the audit event hold it", async () => {
    for (const [value, previous] of [
      ["warn", "off"],
      ["deny", "warn"],
      ["off", "deny"],
    ] as const) {
      const res = await call("admin", "PUT", gate(), { gate: value });
      expect([value, res.status, res.json]).toEqual([value, 200, { gate: value }]);
      expect((await call("viewer", "GET", gate())).json).toEqual({ gate: value });
      const last = (await auditsOf("secret.gate.update")).at(-1);
      expect(last).toMatchObject({
        actorKind: "user",
        resourceType: "organization",
        resourceId: o1,
        metadata: { gate: value, previous },
      });
    }
    expect(await getSecretGate(t.db, o1)).toBe("off");
  });

  test("a member or a viewer may not set it, and nothing changes or is written", async () => {
    const before = (await auditsOf("secret.gate.update")).length;
    for (const who of ["member", "viewer"] as const) {
      const res = await call(who, "PUT", gate(), { gate: "deny" });
      expect([who, res.status]).toEqual([who, 403]);
    }
    expect((await call("viewer", "GET", gate())).json).toEqual({ gate: "off" });
    expect((await auditsOf("secret.gate.update")).length).toBe(before);
  });

  test("a value that is not off, warn or deny, and an unknown field are 422, and no body is refused too", async () => {
    for (const body of [
      { gate: "block" },
      { gate: "" },
      { gate: null },
      {},
      { gate: "deny", x: 1 },
    ]) {
      const res = await call("admin", "PUT", gate(), body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect([400, 422]).toContain((await call("admin", "PUT", gate())).status);
    expect(await getSecretGate(t.db, o1)).toBe("off");
  });

  test("another organization's admin sees 404, and cannot change it; an organization that is not there is 404", async () => {
    const before = (await auditsOf("secret.gate.update")).length;
    expect((await call("outsider", "GET", gate())).status).toBe(404);
    expect((await call("outsider", "PUT", gate(), { gate: "deny" })).status).toBe(404);
    expect((await call("admin", "GET", gate(NO_ORG))).status).toBe(404);
    expect((await call("admin", "PUT", gate(NO_ORG), { gate: "deny" })).status).toBe(404);
    expect(await getSecretGate(t.db, o1)).toBe("off");
    expect((await auditsOf("secret.gate.update")).length).toBe(before);
  });

  test("setting one organization's gate leaves another's alone", async () => {
    expect((await call("outsider", "PUT", gate(o2), { gate: "deny" })).status).toBe(200);
    expect((await call("viewer", "GET", gate())).json).toEqual({ gate: "off" });
    expect(await getSecretGate(t.db, o2)).toBe("deny");
  });

  test("a caller with no session is 401", async () => {
    expect((await call(undefined, "GET", gate())).status).toBe(401);
    expect((await call(undefined, "PUT", gate(), { gate: "deny" })).status).toBe(401);
  });
});
