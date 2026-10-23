import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createOrganization,
  createProject,
  createSession,
  dnsZones,
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
let web: string;
let infra: string;
let theirs: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"owner" | "admin" | "member" | "viewer" | "outsider", string>;

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
  theirs = (await createProject(t.db, { organizationId: o2, name: "theirs" })).id;
  let gitlabId = 800;
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

let n = 0;
const zones = (org = o1) => `/organizations/${org}/dns/zones`;
const claim = (over: object = {}) => ({
  zone: `claim${++n}.example`,
  projectId: web,
  stack: "dns",
  ...over,
});
const make = (over: object = {}, who: keyof typeof people = "admin", org = o1) =>
  call(who, "POST", zones(org), claim(over));
const auditsOf = async (action: string) =>
  await t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, o1)));
const listed = async (who: keyof typeof people = "viewer", org = o1) =>
  (await call(who, "GET", zones(org))).json.items as { id: string; zone: string }[];

describe("claiming a zone", () => {
  test("an org admin claims it; the answer, the list and the audit event hold zone, project and stack", async () => {
    const res = await make({ zone: "acme.example", stack: "public-dns" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      projectId: web,
      zone: "acme.example",
      stack: "public-dns",
    });
    expect((await listed()).map((z) => z.zone)).toContain("acme.example");
    const events = (await auditsOf("dns_zone.create")).filter((e) => e.resourceId === res.json.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "dns_zone",
      metadata: { zone: "acme.example", projectId: web, stack: "public-dns" },
    });
  });

  test("a zone claimed already is a 409 whoever holds it, with nothing stored and nothing audited", async () => {
    const first = await make({ zone: "taken.example" });
    expect(first.status).toBe(201);
    const before = (await auditsOf("dns_zone.create")).length;
    for (const over of [{}, { projectId: infra, stack: "other" }]) {
      const again = await make({ zone: "taken.example", ...over });
      expect(again.status).toBe(409);
      expect(again.json).toMatchObject({ code: "dns_zone_claimed" });
    }
    expect((await listed()).filter((z) => z.zone === "taken.example")).toHaveLength(1);
    expect(await auditsOf("dns_zone.create")).toHaveLength(before);
  });

  test("another organization may claim the same name for its own project", async () => {
    await make({ zone: "shared-name.example" });
    const res = await make({ zone: "shared-name.example", projectId: theirs }, "outsider", o2);
    expect(res.status).toBe(201);
  });

  test("a project that is not the organization's is a 404, and so is an organization that is not there", async () => {
    const res = await make({ projectId: theirs });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "not_found" });
    expect((await make({ projectId: crypto.randomUUID() })).status).toBe(404);
    expect((await call("admin", "POST", zones(crypto.randomUUID()), claim())).status).toBe(404);
  });

  test("refuses what is not a claim, with nothing stored and none of the submitted value in the answer", async () => {
    const before = (await listed()).length;
    const bad: [string, object][] = [
      ["a capital", claim({ zone: "Evil.example" })],
      ["a wildcard", claim({ zone: "*.evil.example" })],
      ["one label", claim({ zone: "evil" })],
      ["a trailing dot", claim({ zone: "evil.example." })],
      ["a space", claim({ zone: "evil zone.example" })],
      ["not punycode", claim({ zone: "bücher-evil.example" })],
      ["a label of 64", claim({ zone: `${"a".repeat(64)}.example` })],
      ["254 characters", claim({ zone: `${"a.".repeat(126)}com` })],
      ["an empty zone", claim({ zone: "" })],
      ["a numeric zone", claim({ zone: 5 })],
      ["no zone", { projectId: web, stack: "dns" }],
      ["a stack with a capital", claim({ stack: "Evil Stack" })],
      ["an empty stack", claim({ stack: "" })],
      ["no stack", { zone: "nostack.example", projectId: web }],
      ["a project that is not an id", claim({ projectId: "web" })],
      ["no project", { zone: "noproject.example", stack: "dns" }],
      ["an extra field", claim({ extra: 1 })],
    ];
    for (const [what, b] of bad) {
      const res = await call("admin", "POST", zones(), b);
      expect([what, res.status]).toEqual([what, 422]);
      expect(res.text).not.toContain("Evil");
      expect(res.text).not.toContain("evil");
    }
    expect(await listed()).toHaveLength(before);
  });
});

describe("who may do what with zone claims", () => {
  test("anyone in the organization reads; only an org admin or owner claims or releases", async () => {
    const one = await make({ zone: "who.example" });
    for (const who of ["owner", "admin", "member", "viewer"] as const) {
      expect([who, (await call(who, "GET", zones())).status]).toEqual([who, 200]);
    }
    for (const who of ["member", "viewer"] as const) {
      const made = await make({ zone: "who-else.example" }, who);
      expect([who, made.status]).toEqual([who, 403]);
      const del = await call(who, "DELETE", `${zones()}/${one.json.id}`);
      expect([who, del.status]).toEqual([who, 403]);
    }
    expect((await make({ zone: "by-owner.example" }, "owner")).status).toBe(201);
    expect((await call("owner", "DELETE", `${zones()}/${one.json.id}`)).status).toBe(204);
    expect((await listed()).map((z) => z.zone)).not.toContain("who-else.example");
  });

  test("a caller with no credentials is 401, and another organization's admin finds nothing: 404", async () => {
    expect((await call(undefined, "GET", zones())).status).toBe(401);
    expect((await call(undefined, "POST", zones(), claim())).status).toBe(401);
    expect((await call(undefined, "DELETE", `${zones()}/${crypto.randomUUID()}`)).status).toBe(401);
    for (const [method, b] of [
      ["GET", undefined],
      ["POST", claim()],
    ] as const) {
      const res = await call("outsider", method, zones(), b);
      expect([method, res.status]).toEqual([method, 404]);
    }
  });

  test("a claim of one organization cannot be released or seen through another", async () => {
    const mine = await make({ zone: "mine.example" });
    expect((await call("outsider", "DELETE", `${zones(o2)}/${mine.json.id}`)).status).toBe(404);
    expect((await call("outsider", "DELETE", `${zones()}/${mine.json.id}`)).status).toBe(404);
    expect((await listed()).map((z) => z.id)).toContain(mine.json.id);
    expect((await listed("outsider", o2)).map((z) => z.id)).not.toContain(mine.json.id);
  });
});

describe("releasing a zone", () => {
  test("releases it, audits it with what it was, and a second release is a 404", async () => {
    const one = await make({ zone: "going.example", stack: "gone-dns" });
    expect((await call("admin", "DELETE", `${zones()}/${one.json.id}`)).status).toBe(204);
    expect((await call("admin", "DELETE", `${zones()}/${one.json.id}`)).status).toBe(404);
    const events = (await auditsOf("dns_zone.delete")).filter((e) => e.resourceId === one.json.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "dns_zone",
      metadata: { zone: "going.example", projectId: web, stack: "gone-dns" },
    });
    expect((await listed()).map((z) => z.id)).not.toContain(one.json.id);
    // the zone can be claimed again
    expect((await make({ zone: "going.example" })).status).toBe(201);
  });

  test("a project's claims go with the project", async () => {
    const doomed = (await createProject(t.db, { organizationId: o1, name: "doomed" })).id;
    await make({ zone: "doomed.example", projectId: doomed });
    await t.db.execute(`delete from projects where id = '${doomed}'`);
    expect((await listed()).map((z) => z.zone)).not.toContain("doomed.example");
    expect(await t.db.select().from(dnsZones).where(eq(dnsZones.projectId, doomed))).toEqual([]);
  });

  test("lists in pages", async () => {
    for (let i = 0; i < 3; i++)
      await make({ zone: `page${i}.example`, projectId: theirs }, "outsider", o2);
    const first = await call("outsider", "GET", `${zones(o2)}?limit=2`);
    expect(first.json.items.length).toBe(2);
    expect(first.json.nextCursor).toBeTruthy();
    const rest = await call(
      "outsider",
      "GET",
      `${zones(o2)}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(rest.status).toBe(200);
    expect(rest.json.items.length).toBeGreaterThanOrEqual(1);
    const seen = [...first.json.items, ...rest.json.items].map((z: { id: string }) => z.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
