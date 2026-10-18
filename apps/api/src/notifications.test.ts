import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createOrganization,
  createProject,
  createSession,
  getSink,
  listSubscriptions,
  notificationSinks,
  openSink,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXSLACKTOKEN";
const HOOK = "https://ops.example.com/orch?token=URLTOKEN123";

let t: TestDb;
let o1: string;
let o2: string;
let p1: string;
let p2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "dave", { id: string; cookie: string }>;

const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
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
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  p1 = (await createProject(t.db, { organizationId: o1, name: "api" })).id;
  p2 = (await createProject(t.db, { organizationId: o2, name: "other" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dave"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin" }, projectRoles: {} }); // alice: admin of one
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob: member of one
  roleTable.set(903, { orgRoles: { [o1]: "viewer" }, projectRoles: {} }); // carol: viewer of one
  roleTable.set(904, { orgRoles: { [o2]: "admin" }, projectRoles: {} }); // dave: admin of two
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
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

const sinks = (org = o1) => `/organizations/${org}/notification-sinks`;
const subs = (org = o1, project = p1) => `/organizations/${org}/projects/${project}/notifications`;
let n = 0;
const hook = (over: object = {}) => ({ kind: "webhook", name: `w${++n}`, url: HOOK, ...over });
const slack = (over: object = {}) => ({ kind: "slack", name: `s${++n}`, url: SLACK, ...over });
const create = async (body: object = hook()) => {
  const res = await call("alice", "POST", sinks(), body);
  expect(res.status).toBe(201);
  return res.json as { id: string; name: string; kind: string; host: string; secret?: string };
};
const auditsOf = async (action: string) =>
  (await t.db.select().from(auditEvents).where(eq(auditEvents.action, action))).filter(
    (e) => e.organizationId === o1,
  );

describe("creating a sink", () => {
  test("a webhook is stored sealed, answers without its address, and shows its signing secret once", async () => {
    const res = await call("alice", "POST", sinks(), hook({ name: "  ops  " }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      kind: "webhook",
      name: "ops",
      host: "ops.example.com",
    });
    expect(res.json.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(res.text).not.toContain("URLTOKEN123");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(res.json).sort()).toEqual([
      "createdAt",
      "host",
      "id",
      "kind",
      "name",
      "organizationId",
      "secret",
      "updatedAt",
    ]);
    // what is stored is the address and the very secret that was shown
    const opened = await openSink(t.db, keys, o1, res.json.id);
    expect(JSON.parse(opened?.secret ?? "{}")).toEqual({ url: HOOK, secret: res.json.secret });
    const [row] = await t.db
      .select()
      .from(notificationSinks)
      .where(eq(notificationSinks.id, res.json.id));
    expect(Buffer.from(row?.secretEnc ?? []).toString("latin1")).not.toContain("URLTOKEN123");
  });

  test("a slack hook is the credential itself: stored sealed, no secret to show", async () => {
    const res = await call("alice", "POST", sinks(), slack());
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: "slack", host: "hooks.slack.com" });
    expect(res.json).not.toHaveProperty("secret");
    expect(res.text).not.toContain("XXXXSLACKTOKEN");
    const opened = await openSink(t.db, keys, o1, res.json.id);
    expect(JSON.parse(opened?.secret ?? "{}")).toEqual({ url: SLACK });
  });

  test("is audited with its kind, name and host, and with neither address nor secret", async () => {
    const made = await create(hook({ name: "audited" }));
    const events = (await auditsOf("notification.sink.create")).filter(
      (e) => e.resourceId === made.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "notification_sink",
      actorId: people.alice.id,
      metadata: { kind: "webhook", name: "audited", host: "ops.example.com" },
    });
    const all = JSON.stringify(await t.db.select().from(auditEvents));
    expect(all).not.toContain("URLTOKEN123");
    expect(all).not.toContain("XXXXSLACKTOKEN");
    expect(all).not.toContain(made.secret ?? "no secret");
  });

  test("refuses what is not a kind, a name or an address a sink may have, without echoing it", async () => {
    const empty = await call("alice", "POST", sinks(), {});
    expect([empty.status, empty.json.code]).toEqual([422, "validation_failed"]);
    const bad = [
      { kind: "email" },
      { name: "" },
      { name: "x".repeat(101) },
      { url: "" },
      { url: "not a url" },
      { url: "http://ops.example.com/in" },
      { url: "https://user:hunter2@ops.example.com/in" },
      { url: "https://localhost/in" },
      { url: "https://127.0.0.1/in" },
      { url: "https://169.254.169.254/latest/meta-data" },
      { url: "https://10.0.0.5/in" },
      { url: "https://[::1]/in" },
      { url: "https://intranet/in" },
      { url: `https://ops.example.com/${"a".repeat(2000)}` },
      { secret: "mine" },
      { organizationId: o2 },
    ];
    for (const over of bad) {
      const res = await call("alice", "POST", sinks(), { ...hook(), ...over });
      expect([over, res.status, res.json.code]).toEqual([over, 422, "validation_failed"]);
      expect(res.text).not.toContain("hunter2");
    }
    for (const over of [
      { url: "https://hooks.example.com/services/T/B/X" },
      { url: "https://hooks.slack.com.evil.example/services/T/B/X" },
      { url: "https://hooks.slack.com/api/chat.postMessage" },
    ]) {
      const res = await call("alice", "POST", sinks(), { ...slack(), ...over });
      expect([over, res.status, res.json.code]).toEqual([over, 422, "validation_failed"]);
    }
  });

  test("a name is taken within the organization only", async () => {
    await create(hook({ name: "dup" }));
    const again = await call("alice", "POST", sinks(), hook({ name: "dup" }));
    expect([again.status, again.json.code]).toEqual([409, "name_taken"]);
    const other = await call("dave", "POST", sinks(o2), hook({ name: "dup" }));
    expect(other.status).toBe(201);
  });

  test("without master keys nothing is stored", async () => {
    const before = (await t.db.select().from(notificationSinks)).length;
    const res = await call("alice", "POST", sinks(), hook(), makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await t.db.select().from(notificationSinks)).toHaveLength(before);
  });

  test("an organization that does not exist is a 404", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    roleTable.set(901, { orgRoles: { [o1]: "admin", [ghost]: "admin" }, projectRoles: {} });
    try {
      for (const [method, path, body] of [
        ["POST", sinks(ghost), hook()],
        ["GET", sinks(ghost)],
      ] as [string, string, unknown?][]) {
        expect([method, (await call("alice", method, path, body)).status]).toEqual([method, 404]);
      }
    } finally {
      roleTable.set(901, { orgRoles: { [o1]: "admin" }, projectRoles: {} });
    }
  });
});

describe("listing and deleting sinks", () => {
  test("a list shows the organization's sinks and nothing of their addresses", async () => {
    const mine = await create(hook({ name: "listed" }));
    await call("dave", "POST", sinks(o2), hook({ name: "theirs" }));
    const res = await call("alice", "GET", `${sinks()}?limit=100`);
    expect(res.status).toBe(200);
    const names = res.json.items.map((s: { name: string }) => s.name);
    expect(names).toContain("listed");
    expect(names).not.toContain("theirs");
    expect(res.text).not.toContain("URLTOKEN123");
    expect(res.text).not.toContain("whsec_");
    expect(res.json.items.find((s: { id: string }) => s.id === mine.id)).not.toHaveProperty(
      "secret",
    );
  });

  test("a list is paged", async () => {
    const a = await call("alice", "GET", `${sinks()}?limit=1`);
    expect(a.json.items).toHaveLength(1);
    expect(a.json.nextCursor).toBeString();
    const b = await call("alice", "GET", `${sinks()}?limit=1&cursor=${a.json.nextCursor}`);
    expect(b.json.items[0].id).not.toBe(a.json.items[0].id);
  });

  test("deleting removes it once, takes its subscriptions along, and is audited", async () => {
    const made = await create(hook({ name: "doomed" }));
    expect(
      (await call("alice", "PUT", `${subs()}/${made.id}`, { events: ["stack.drift"] })).status,
    ).toBe(200);
    expect((await call("alice", "DELETE", `${sinks()}/${made.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", `${sinks()}/${made.id}`)).status).toBe(404);
    expect(await getSink(t.db, o1, made.id)).toBeUndefined();
    const left = await listSubscriptions(t.db, o1, p1, { limit: 1000 });
    expect(left.some((s) => s.sinkId === made.id)).toBe(false);
    const events = (await auditsOf("notification.sink.delete")).filter(
      (e) => e.resourceId === made.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({
      kind: "webhook",
      name: "doomed",
      host: "ops.example.com",
    });
  });

  test("another organization's sink is not found, not refused", async () => {
    const theirs = (await call("dave", "POST", sinks(o2), hook({ name: "hidden" }))).json;
    expect((await call("alice", "DELETE", `${sinks()}/${theirs.id}`)).status).toBe(404);
    expect((await getSink(t.db, o2, theirs.id))?.id).toBe(theirs.id);
  });
});

describe("what a project asks of a sink", () => {
  test("setting the events is idempotent, replaces what was there, and is audited", async () => {
    const made = await create(hook({ name: "sub" }));
    const set = () =>
      call("alice", "PUT", `${subs()}/${made.id}`, { events: ["stack.drift", "stack.drift"] });
    const first = await set();
    expect([first.status, first.json]).toEqual([200, { sinkId: made.id, events: ["stack.drift"] }]);
    expect((await set()).status).toBe(200);
    const listed = await call("alice", "GET", subs());
    expect(listed.json.items.filter((s: { sinkId: string }) => s.sinkId === made.id)).toEqual([
      {
        sinkId: made.id,
        name: "sub",
        kind: "webhook",
        host: "ops.example.com",
        event: "stack.drift",
      },
    ]);
    const events = (await auditsOf("notification.subscription.update")).filter(
      (e) => e.resourceId === made.id,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      resourceType: "notification_sink",
      projectId: p1,
      metadata: { events: ["stack.drift"] },
    });
  });

  test("removing says it was there once", async () => {
    const made = await create(hook({ name: "unsub" }));
    await call("alice", "PUT", `${subs()}/${made.id}`, { events: ["stack.drift"] });
    expect((await call("alice", "DELETE", `${subs()}/${made.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", `${subs()}/${made.id}`)).status).toBe(404);
    expect(
      (await call("alice", "GET", subs())).json.items.some(
        (s: { sinkId: string }) => s.sinkId === made.id,
      ),
    ).toBe(false);
    expect(
      (await auditsOf("notification.subscription.delete")).filter((e) => e.resourceId === made.id),
    ).toHaveLength(1);
  });

  test("refuses events nobody sends, and none at all", async () => {
    const made = await create(hook({ name: "events" }));
    for (const events of [[], ["run.apply"], ["stack.drift", "nope"], "stack.drift", undefined]) {
      const res = await call("alice", "PUT", `${subs()}/${made.id}`, { events });
      expect([events, res.status, res.json.code]).toEqual([events, 422, "validation_failed"]);
    }
  });

  test("a project cannot use another organization's sink, nor another organization's project", async () => {
    const theirs = (await call("dave", "POST", sinks(o2), hook({ name: "foreign" }))).json;
    const mine = await create(hook({ name: "mine" }));
    const body = { events: ["stack.drift"] };
    expect((await call("alice", "PUT", `${subs()}/${theirs.id}`, body)).status).toBe(404);
    expect((await call("alice", "PUT", `${subs(o1, p2)}/${mine.id}`, body)).status).toBe(404);
    expect((await call("alice", "GET", subs(o1, p2))).status).toBe(404);
    expect((await call("alice", "DELETE", `${subs()}/${theirs.id}`)).status).toBe(404);
    expect(await listSubscriptions(t.db, o2, p2, { limit: 10 })).toEqual([]);
  });
});

describe("who may", () => {
  const made = async () => (await create(hook({ name: `who${++n}` }))).id;

  test("only an organization admin sets where notifications go; strangers see nothing", async () => {
    const id = await made();
    const calls: [string, string, unknown?][] = [
      ["GET", sinks()],
      ["POST", sinks(), hook()],
      ["DELETE", `${sinks()}/${id}`],
      ["PUT", `${subs()}/${id}`, { events: ["stack.drift"] }],
      ["DELETE", `${subs()}/${id}`],
    ];
    const before = (await t.db.select().from(notificationSinks)).length;
    for (const [method, path, body] of calls) {
      const answer = async (who: keyof typeof people | undefined) =>
        [who, method, path, (await call(who, method, path, body)).status] as const;
      expect(await answer(undefined)).toEqual([undefined, method, path, 401]);
      expect(await answer("bob")).toEqual(["bob", method, path, 403]); // member
      expect(await answer("carol")).toEqual(["carol", method, path, 403]); // viewer
      expect(await answer("dave")).toEqual(["dave", method, path, 404]); // another organization's admin
    }
    expect((await getSink(t.db, o1, id))?.id).toBe(id);
    expect(await t.db.select().from(notificationSinks)).toHaveLength(before);
  });

  test("anyone who can read the project may see which sinks hear of it", async () => {
    const id = await made();
    await call("alice", "PUT", `${subs()}/${id}`, { events: ["stack.drift"] });
    for (const who of ["alice", "bob", "carol"] as const) {
      const res = await call(who, "GET", subs());
      expect([who, res.status]).toEqual([who, 200]);
      expect(res.json.items.some((s: { sinkId: string }) => s.sinkId === id)).toBe(true);
      expect(res.text).not.toContain("URLTOKEN123");
    }
    expect((await call("dave", "GET", subs())).status).toBe(404);
  });
});
