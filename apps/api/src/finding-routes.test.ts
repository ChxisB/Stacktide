import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, parseSecretReport, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createOrganization,
  createProject,
  createSession,
  listFindings,
  secretFindings,
  upsertFindings,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
/** What a planted secret looks like: if it is in an answer or an audit event, a field was copied that must not be. */
const SECRET = "AKIAIOSFODNN7CANARY0";

let t: TestDb;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "dana" | "erin", { cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "p1" | "p2" | "p3", string>;
let app: ReturnType<typeof makeApp>;

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });

// a report whose every free-text field carries the secret: what survives the parser is all the platform ever holds
const report = JSON.stringify({
  version: "15.1.0",
  scan: { status: "success", type: "secret_detection" },
  vulnerabilities: ["f1", "f2", "f3"].map((id) => ({
    id,
    category: "secret_detection",
    name: `Key ${SECRET}`,
    description: `Found ${SECRET}`,
    severity: "Critical",
    raw_source_code_extract: `aws_key = ${SECRET}`,
    location: {
      file: "src/config.ts",
      start_line: 7,
      commit: { sha: "a1b2c3d4e5f6", message: `add ${SECRET}`, author: SECRET },
    },
    identifiers: [{ type: "gitleaks_rule_id", name: "rule", value: "aws-access-token" }],
  })),
});

beforeAll(async () => {
  t = await createTestDb();
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  const project = async (organizationId: string, name: string) =>
    (await createProject(t.db, { organizationId, name })).id;
  ids.p1 = await project(ids.o1, "p1");
  ids.p2 = await project(ids.o1, "p2");
  ids.p3 = await project(ids.o2, "p3");
  let gitlabId = 800;
  for (const name of ["alice", "bob", "carol", "erin", "dana"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { cookie: `orch_session=${session}` };
  }
  roleTable.set(801, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(802, { orgRoles: {}, projectRoles: { [ids.p1]: "developer" } }); // bob
  roleTable.set(803, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(804, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  roleTable.set(805, { orgRoles: {}, projectRoles: { [ids.p1]: "maintainer" } }); // dana
  const parsed = parseSecretReport(report);
  if (!parsed.ok) throw new Error("the fixture report must parse");
  for (const [organizationId, projectId] of [
    [ids.o1, ids.p1],
    [ids.o1, ids.p2],
    [ids.o2, ids.p3],
  ] as const) {
    await upsertFindings(t.db, {
      organizationId,
      projectId,
      ref: "main",
      findings: parsed.findings,
    });
  }
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

type Who = keyof typeof people | undefined;
const seen: string[] = [];
async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push(text);
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const base = (org = ids.o1, p = ids.p1) => `/organizations/${org}/projects/${p}/findings`;
const list = (who: Who, query = "", org = ids.o1, p = ids.p1) =>
  call(who, "GET", `${base(org, p)}${query}`);
const firstOf = async (p = ids.p1, org = ids.o1) =>
  (await listFindings(t.db, org, p, { limit: 10 }))[0];
const rows = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const dismiss = (who: Who, id: string, body: unknown = { reason: "a test key" }, p = ids.p1) =>
  call(who, "POST", `${base(ids.o1, p)}/${id}/dismiss`, body);
const reopen = (who: Who, id: string, p = ids.p1) =>
  call(who, "POST", `${base(ids.o1, p)}/${id}/reopen`);

describe("who may see and triage findings", () => {
  test("a member of the project reads them; someone with no part in it finds nothing", async () => {
    for (const who of ["carol", "bob", "dana", "alice"] as const) {
      const res = await list(who);
      expect([who, res.status, res.json.items.length]).toEqual([who, 200, 3]);
    }
    expect((await list("erin")).status).toBe(404); // an admin of another organization
    expect((await list("carol", "", ids.o1, ids.p2)).status).toBe(404); // a member of a sibling project
    expect((await list(undefined)).status).toBe(401);
    // the project of another organization is not reached by naming it under one's own
    expect((await list("alice", "", ids.o1, ids.p3)).status).toBe(404);
  });

  test("one finding by id, only through its own project", async () => {
    const f = await firstOf();
    const res = await call("carol", "GET", `${base()}/${f?.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: f?.id,
      rule: "aws-access-token",
      path: "src/config.ts",
      line: 7,
      commit: "a1b2c3d4e5f6",
      severity: "critical",
      ref: "main",
      status: "open",
      dismissedReason: null,
      dismissedBy: null,
      dismissedAt: null,
    });
    expect((await call("carol", "GET", `${base(ids.o1, ids.p2)}/${f?.id}`)).status).toBe(404);
    expect((await call("carol", "GET", `${base()}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("carol", "GET", `${base()}/not-a-uuid`)).status).toBe(422);
  });

  test("only a maintainer dismisses or reopens; a developer or reporter is refused", async () => {
    const f = await firstOf();
    for (const who of ["carol", "bob"] as const) {
      expect([who, (await dismiss(who, f?.id ?? "")).status]).toEqual([who, 403]);
      expect([who, (await reopen(who, f?.id ?? "")).status]).toEqual([who, 403]);
    }
    expect((await dismiss("erin", f?.id ?? "")).status).toBe(404);
    expect((await dismiss(undefined, f?.id ?? "")).status).toBe(401);
    expect((await firstOf())?.status).toBe("open");
  });
});

describe("listing", () => {
  test("pages by cursor and filters by status", async () => {
    const first = await list("carol", "?limit=2");
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toBeTruthy();
    const rest = await list("carol", `?limit=2&cursor=${first.json.nextCursor}`);
    expect(rest.json.items).toHaveLength(1);
    expect(rest.json.nextCursor).toBeNull();

    expect((await list("carol", "?status=dismissed")).json.items).toEqual([]);
    expect((await list("carol", "?status=open")).json.items).toHaveLength(3);
    expect((await list("carol", "?status=ignored")).status).toBe(422);
  });
});

describe("dismissing and reopening", () => {
  test("a dismissal needs a reason, and says who and why; it is audited", async () => {
    const f = await firstOf(ids.p2);
    const id = f?.id ?? "";
    // no reason, an empty one, a blank one, one too long, an unknown field: all 422, and nothing changed
    for (const body of [
      {},
      { reason: "" },
      { reason: "   " },
      { reason: "x".repeat(1001) },
      { reason: "ok", status: "resolved" },
    ]) {
      expect([body, (await dismiss("alice", id, body, ids.p2)).status]).toEqual([body, 422]);
    }
    // and no body at all
    expect([400, 422]).toContain(
      (await call("alice", "POST", `${base(ids.o1, ids.p2)}/${id}/dismiss`)).status,
    );
    expect((await firstOf(ids.p2))?.status).toBe("open");
    expect(await rows("finding.dismiss")).toEqual([]);

    const res = await dismiss("alice", id, { reason: "  an example key in the docs  " }, ids.p2);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id,
      status: "dismissed",
      dismissedReason: "an example key in the docs",
      dismissedBy: expect.stringMatching(/^user:/),
    });
    expect(res.json.dismissedAt).toBeTruthy();

    const [event] = await rows("finding.dismiss");
    expect(event).toMatchObject({
      resourceType: "finding",
      resourceId: id,
      organizationId: ids.o1,
      projectId: ids.p2,
    });
    expect(event?.metadata).toMatchObject({
      rule: "aws-access-token",
      path: "src/config.ts",
      reason: "an example key in the docs",
    });
  });

  test("a second dismissal, or reopening what is not dismissed, is a conflict that changes nothing", async () => {
    const f = await firstOf(ids.p2);
    const id = f?.id ?? "";
    const again = await dismiss("alice", id, { reason: "another" }, ids.p2);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("finding_not_open");
    const stillTheFirst = await call("alice", "GET", `${base(ids.o1, ids.p2)}/${id}`);
    expect(stillTheFirst.json.dismissedReason).toBe("an example key in the docs");

    const other = (await listFindings(t.db, ids.o1, ids.p2, { limit: 10 }))[1];
    const open = await reopen("alice", other?.id ?? "", ids.p2);
    expect(open.status).toBe(409);
    expect(open.json.code).toBe("finding_not_dismissed");
    expect(await rows("finding.reopen")).toEqual([]);
  });

  test("reopening clears the dismissal, is audited, and the audit keeps what was said", async () => {
    const f = await firstOf(ids.p2);
    // dana only holds p1: she finds nothing in p2
    expect((await reopen("dana", f?.id ?? "", ids.p2)).status).toBe(404);

    const ok = await reopen("alice", f?.id ?? "", ids.p2);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      status: "open",
      dismissedReason: null,
      dismissedBy: null,
      dismissedAt: null,
    });
    const [event] = await rows("finding.reopen");
    expect(event).toMatchObject({ resourceType: "finding", resourceId: f?.id, projectId: ids.p2 });
  });

  test("a finding of another project is not reached through this one", async () => {
    const foreign = await firstOf(ids.p2);
    expect((await dismiss("dana", foreign?.id ?? "")).status).toBe(404);
    expect((await reopen("dana", foreign?.id ?? "")).status).toBe(404);
    expect((await firstOf(ids.p2))?.status).toBe("open");
  });

  test("a finding that is resolved cannot be dismissed", async () => {
    const f = (await listFindings(t.db, ids.o2, ids.p3, { limit: 10 }))[0];
    await t.db
      .update(secretFindings)
      .set({ status: "resolved" })
      .where(eq(secretFindings.id, f?.id ?? ""));
    const res = await call("erin", "POST", `${base(ids.o2, ids.p3)}/${f?.id}/dismiss`, {
      reason: "x",
    });
    expect([res.status, res.json.code]).toEqual([409, "finding_not_open"]);
  });
});

describe("what an answer holds", () => {
  test("the secret planted in the report is in no answer and no audit event; items hold exactly the known fields", async () => {
    const f = await firstOf();
    const one = await call("carol", "GET", `${base()}/${f?.id}`);
    expect(Object.keys(one.json).sort()).toEqual([
      "commit",
      "createdAt",
      "dismissedAt",
      "dismissedBy",
      "dismissedReason",
      "firstSeenAt",
      "id",
      "lastSeenAt",
      "line",
      "organizationId",
      "path",
      "projectId",
      "ref",
      "rule",
      "severity",
      "status",
    ]);
    await dismiss("dana", f?.id ?? "");
    await reopen("dana", f?.id ?? "");
    await list("carol");
    await dismiss("carol", f?.id ?? "");
    await call("carol", "GET", `${base()}/${crypto.randomUUID()}`);
    expect(seen.length).toBeGreaterThan(10);
    for (const text of seen) expect(text).not.toContain(SECRET);
    const audit = await t.db.select().from(auditEvents);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
