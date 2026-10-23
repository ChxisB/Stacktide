import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  ciTokens,
  createApiToken,
  createCiToken,
  createOrganization,
  createProject,
  createSession,
  MAX_STATE_BYTES,
  stateLocks,
  stateResources,
  stateVersions,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newApiToken, newCiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "STATE-CANARY-7f3a9c-do-not-leak";
const HOUR = 3_600_000;

let t: TestDb;
const lines: string[] = [];
const seen: string[] = []; // every answer, to look for the canary in
const ids = {} as Record<"o1" | "o2" | "p1" | "p2", string>;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"maintainer" | "admin", { id: string; cookie: string }>;
const make = (withKeys = true) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId ?? 0) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    ...(withKeys && { keys }),
  });
let app: ReturnType<typeof make>;

const stack = (name: string) => ({
  name,
  path: name,
  tool: "tofu" as const,
  version: null,
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command" as const,
  backend: "http" as const,
});

beforeAll(async () => {
  t = await createTestDb();
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o2, name: "p2" })).id;
  await syncStacks(t.db, ids.o1, ids.p1, [stack("net"), stack("dns")], { prune: true });
  await syncStacks(t.db, ids.o2, ids.p2, [stack("net")], { prune: true });
  let gitlabId = 900;
  for (const name of ["maintainer", "admin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: {}, projectRoles: { [ids.p1]: "maintainer" } });
  roleTable.set(902, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} });
  app = make();
});
afterAll(async () => {
  await t.drop();
});

const ciToken = async (
  over: {
    project?: string;
    org?: string;
    scopes?: string[];
    ttlMs?: number;
    job?: number | null; // null: a GitHub job, which has a workflow run (`pipeline`) and no job id
    pipeline?: number;
  } = {},
) => {
  const fresh = newCiToken();
  await createCiToken(t.db, {
    organizationId: over.org ?? ids.o1,
    projectId: over.project ?? ids.p1,
    tokenHash: fresh.tokenHash,
    scopes: over.scopes ?? ["project.read", "state.read", "state.write"],
    gitlabProjectId: 1,
    ...(over.job !== null && { gitlabJobId: over.job ?? 4242 }),
    ...(over.pipeline && { gitlabPipelineId: over.pipeline }),
    ref: "main",
    refProtected: true,
    ttlMs: over.ttlMs ?? HOUR,
  });
  return fresh.token;
};
const apiToken = async (scopes: string[]) => {
  const fresh = newApiToken();
  await createApiToken(t.db, {
    userId: people.maintainer.id,
    name: "t",
    prefix: fresh.prefix,
    tokenHash: fresh.tokenHash,
    scopes,
    ttlMs: HOUR,
  });
  return fresh.token;
};

/** What Terraform's `http` backend sends: HTTP Basic, whatever the user name, the password being `TF_HTTP_PASSWORD`. */
const basic = (password: string) =>
  `Basic ${Buffer.from(`gitlab-ci-token:${password}`).toString("base64")}`;

const at = (stackName = "net", org = ids.o1, project = ids.p1) =>
  `/organizations/${org}/projects/${project}/state/${stackName}`;

interface Sent {
  authorization?: string;
  cookie?: string;
  body?: string;
  headers?: Record<string, string>;
  app?: typeof app;
}
async function send(method: string, path: string, o: Sent = {}) {
  const headers: Record<string, string> = { ...o.headers };
  if (o.authorization) headers.authorization = o.authorization;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.app ?? app).handle(
    new Request(`http://localhost${path}`, { method, headers, body: o.body }),
  );
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    text,
    headers: res.headers,
    json: (text && res.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : undefined) as { code?: string; [field: string]: unknown },
  };
}

const doc = (serial: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 4,
    terraform_version: "1.9.0",
    serial,
    lineage: "lineage-1",
    outputs: { password: { value: CANARY, type: "string", sensitive: true } },
    resources: [],
    ...over,
  });
const rows = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(auditEvents.id);
const held = (project = ids.p1) =>
  t.db
    .select({ id: stateVersions.id })
    .from(stateVersions)
    .where(eq(stateVersions.projectId, project))
    .then((r) => r.length);

describe("Terraform's http backend, as Terraform speaks it", () => {
  test("reads nothing, writes, reads the same bytes back, moves forward, and deletes", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };

    // Terraform reads 404 as "no state yet"
    expect((await send("GET", at("dns"), as)).status).toBe(404);

    const first = doc(1);
    const put = await send("POST", `${at("dns")}?ID=lock-1`, { ...as, body: first });
    expect(put.status).toBe(200);
    const got = await send("GET", at("dns"), as);
    expect(got.status).toBe(200);
    expect(got.text).toBe(first); // byte for byte: Terraform checks what it reads
    expect(got.headers.get("content-type")).toContain("application/json");
    expect(got.headers.get("cache-control")).toBe("no-store");

    const second = doc(2, { serial: 2 });
    expect((await send("POST", at("dns"), { ...as, body: second })).status).toBe(200);
    expect((await send("GET", at("dns"), as)).text).toBe(second);

    // the same write again is a retry; it is not an error
    expect((await send("POST", at("dns"), { ...as, body: second })).status).toBe(200);

    const gone = await send("DELETE", at("dns"), as);
    expect(gone.status).toBe(200);
    expect((await send("GET", at("dns"), as)).status).toBe(404);
  });

  test("a serial that goes back, a lineage that changes, and the same serial with other content are conflicts, and change nothing", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    expect((await send("POST", at(), { ...as, body: doc(5) })).status).toBe(200);

    const back = await send("POST", at(), { ...as, body: doc(4) });
    expect(back.status).toBe(409);
    expect(back.json.code).toBe("serial_too_low");
    const lineage = await send("POST", at(), { ...as, body: doc(6, { lineage: "another" }) });
    expect(lineage.status).toBe(409);
    expect(lineage.json.code).toBe("lineage_changed");
    const same = await send("POST", at(), { ...as, body: doc(5, { terraform_version: "1.10.0" }) });
    expect(same.status).toBe(409);
    expect(same.json.code).toBe("serial_conflict");
    expect((await send("GET", at(), as)).text).toBe(doc(5));
    await send("DELETE", at(), as);
  });

  test("what is not Terraform state is refused without storing anything, and the answer does not echo it", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    const bad = [
      `not json ${CANARY}`,
      JSON.stringify([CANARY]),
      JSON.stringify({ version: 3, serial: 1, lineage: "l", note: CANARY }),
      JSON.stringify({ version: 4, lineage: "l", note: CANARY }),
      JSON.stringify({ version: 4, serial: 1.5, lineage: "l", note: CANARY }),
      JSON.stringify({ version: 4, serial: -1, lineage: "l", note: CANARY }),
      JSON.stringify({ version: 4, serial: "1", lineage: "l", note: CANARY }),
      JSON.stringify({ version: 4, serial: 1, lineage: 5, note: CANARY }),
      JSON.stringify({ version: 4, serial: 1, lineage: "", note: CANARY }),
      JSON.stringify({ version: 4, serial: 1, lineage: "x".repeat(257), note: CANARY }),
      JSON.stringify({ version: 4, serial: 2 ** 31, lineage: "l", note: CANARY }),
    ];
    for (const body of bad) {
      const res = await send("POST", at("dns"), { ...as, body });
      expect([body.slice(0, 40), res.status]).toEqual([body.slice(0, 40), 422]);
      expect(res.json.code).toBe("invalid_state");
      expect(res.text).not.toContain(CANARY);
    }
    expect((await send("GET", at("dns"), as)).status).toBe(404);
  });

  test("a state over the body cap is a 413 before anything is read, and one over the repository's own limit is a 413 too", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    // declared too long: the edge answers, as for every route
    const declared = await send("POST", at("dns"), {
      ...as,
      body: doc(1),
      headers: { "content-length": String(3 * 1024 * 1024) },
    });
    expect(declared.status).toBe(413);
    expect(declared.json.code).toBe("payload_too_large");

    // not declared (chunked): the route stops reading at the repository's limit
    const big = doc(1, { padding: "x".repeat(MAX_STATE_BYTES) });
    const res = await send("POST", at("dns"), { ...as, body: big });
    expect(res.status).toBe(413);
    expect(res.json.code).toBe("payload_too_large");
    expect((await send("GET", at("dns"), as)).status).toBe(404);
  });
});

describe("who may reach the state", () => {
  test("Basic credentials carry a CI token on the state routes and nowhere else", async () => {
    const token = await ciToken({ scopes: ["project.read", "state.read", "run.read"] });
    const run = `/organizations/${ids.o1}/projects/${ids.p1}/runs`;
    expect((await send("GET", at(), { authorization: basic(token) })).status).toBe(404); // allowed in, nothing there
    expect((await send("GET", run, { authorization: basic(token) })).status).toBe(401);
    expect((await send("GET", run, { authorization: `Bearer ${token}` })).status).toBe(200);
    // and a Bearer token works on the state routes too
    expect((await send("GET", at(), { authorization: `Bearer ${token}` })).status).toBe(404);
  });

  test("no credential, a wrong password and something that is not a CI token are 401", async () => {
    const api = await apiToken(["state.read", "project.read"]);
    expect((await send("GET", at())).status).toBe(401);
    expect((await send("GET", at(), { authorization: basic("wrong") })).status).toBe(401);
    expect((await send("GET", at(), { authorization: basic(api) })).status).toBe(401); // an API token is never a Basic password
    expect((await send("GET", at(), { authorization: "Basic !!!" })).status).toBe(401);
    expect((await send("POST", at(), { body: doc(1) })).status).toBe(401);
    expect((await send("DELETE", at())).status).toBe(401);
  });

  test("a person gets no state: not with a session, not with a token that names the scope", async () => {
    const writer = await ciToken();
    await send("POST", at(), { authorization: basic(writer), body: doc(1) });
    const api = await apiToken(["state.read", "state.write", "project.read"]);
    for (const who of [{ cookie: people.maintainer.cookie }, { cookie: people.admin.cookie }]) {
      expect((await send("GET", at(), who)).status).toBe(403);
      expect((await send("POST", at(), { ...who, body: doc(2) })).status).toBe(403);
      expect((await send("DELETE", at(), who)).status).toBe(403);
    }
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await send(method, at(), {
        authorization: `Bearer ${api}`,
        ...(method === "POST" && { body: doc(2) }),
      });
      expect([method, res.status]).toEqual([method, 403]);
    }
    expect((await send("GET", at(), { authorization: basic(writer) })).text).toBe(doc(1));
    await send("DELETE", at(), { authorization: basic(writer) });
  });

  test("a token that may read cannot write or delete, and a token without the scopes cannot even read", async () => {
    const writer = await ciToken();
    await send("POST", at(), { authorization: basic(writer), body: doc(1) });
    const reader = await ciToken({ scopes: ["project.read", "state.read"] });
    const plain = await ciToken({ scopes: ["project.read", "run.summary"] });

    expect((await send("GET", at(), { authorization: basic(reader) })).text).toBe(doc(1));
    expect((await send("POST", at(), { authorization: basic(reader), body: doc(2) })).status).toBe(
      403,
    );
    expect((await send("DELETE", at(), { authorization: basic(reader) })).status).toBe(403);
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await send(method, at(), {
        authorization: basic(plain),
        ...(method === "POST" && { body: doc(2) }),
      });
      expect([method, res.status]).toEqual([method, 403]);
    }
    expect((await send("GET", at(), { authorization: basic(writer) })).text).toBe(doc(1));
    await send("DELETE", at(), { authorization: basic(writer) });
  });

  test("a token is held to its own project: another project, another organization and a stack the project lacks", async () => {
    const mine = await ciToken();
    const theirs = await ciToken({ org: ids.o2, project: ids.p2 });
    await send("POST", at(), { authorization: basic(mine), body: doc(1) });
    await send("POST", at("net", ids.o2, ids.p2), {
      authorization: basic(theirs),
      body: doc(1, { lineage: "theirs" }),
    });

    // each project's `net` is its own state
    expect(
      (await send("GET", at("net", ids.o2, ids.p2), { authorization: basic(theirs) })).json,
    ).toMatchObject({
      lineage: "theirs",
    });
    expect((await send("GET", at(), { authorization: basic(mine) })).json).toMatchObject({
      lineage: "lineage-1",
    });

    // the other project's path, and the right project under the wrong organization: not found, as for every route
    for (const path of [
      at("net", ids.o2, ids.p2),
      at("net", ids.o2, ids.p1),
      at("net", ids.o1, ids.p2),
    ]) {
      for (const method of ["GET", "DELETE"]) {
        const res = await send(method, path, { authorization: basic(mine) });
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
      expect((await send("POST", path, { authorization: basic(mine), body: doc(9) })).status).toBe(
        404,
      );
    }
    // a stack the project does not have: nothing to read or write (deleting is allowed, see the test after this one)
    const read = await send("GET", at("ghost"), { authorization: basic(mine) });
    expect([read.status, read.json.code]).toEqual([403, "unknown_stack"]);
    const ghost = await send("POST", at("ghost"), { authorization: basic(mine), body: doc(1) });
    expect([ghost.status, ghost.json.code]).toEqual([403, "unknown_stack"]);
    expect(
      (await send("GET", at("net", ids.o2, ids.p2), { authorization: basic(theirs) })).status,
    ).toBe(200);
    await send("DELETE", at(), { authorization: basic(mine) });
    await send("DELETE", at("net", ids.o2, ids.p2), { authorization: basic(theirs) });
  });

  test("the state of a stack taken out of the repository can still be deleted, and nothing else about it can be reached", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    await syncStacks(t.db, ids.o1, ids.p1, [stack("net"), stack("dns"), stack("gone")], {
      prune: true,
    });
    expect((await send("POST", at("gone"), { ...as, body: doc(1) })).status).toBe(200);
    await syncStacks(t.db, ids.o1, ids.p1, [stack("net"), stack("dns")], { prune: true });

    expect((await send("GET", at("gone"), as)).status).toBe(403);
    expect((await send("POST", at("gone"), { ...as, body: doc(2) })).status).toBe(403);
    const gone = await send("DELETE", at("gone"), as);
    expect(gone.status).toBe(200);
    expect(gone.json).toEqual({ versions: 1 });
    expect(await held()).toBe(0);
    // a name that is no stack's and has no state: nothing to delete, still a 200
    expect((await send("DELETE", at("never"), as)).json).toEqual({ versions: 0 });
  });

  test("a token that has expired is nobody", async () => {
    const token = await ciToken();
    expect((await send("GET", at(), { authorization: basic(token) })).status).toBe(404);
    await t.db
      .update(ciTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(ciTokens.tokenHash, hashToken(token)));
    expect((await send("GET", at(), { authorization: basic(token) })).status).toBe(401);
  });

  test("without a master key the state cannot be sealed or opened, and it says so", async () => {
    const keyless = make(false);
    const token = await ciToken();
    const as = { authorization: basic(token), app: keyless };
    expect((await send("GET", at(), as)).status).toBe(503);
    expect((await send("POST", at(), { ...as, body: doc(1) })).status).toBe(503);
    expect((await send("DELETE", at(), as)).status).toBe(503);
  });
});

describe("what is recorded, and what is not", () => {
  test("every read, write and delete is audited with ids, serial and size, and a refused one is not", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    const before = {
      read: (await rows("state.read")).length,
      write: (await rows("state.write")).length,
      del: (await rows("state.delete")).length,
    };
    await send("POST", at(), { ...as, body: doc(1) });
    await send("POST", at(), { ...as, body: doc(1) }); // a retry
    await send("POST", at(), { ...as, body: doc(0) }); // refused
    await send("GET", at(), as);
    await send("DELETE", at(), as);
    await send("GET", at("dns"), as); // nothing there: nothing read

    const writes = (await rows("state.write")).slice(before.write);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      actorKind: "ci",
      resourceType: "state",
      organizationId: ids.o1,
      projectId: ids.p1,
    });
    expect(writes[0]?.metadata).toMatchObject({
      stack: "net",
      serial: 1,
      sizeBytes: Buffer.byteLength(doc(1)),
      unchanged: false,
    });
    expect(writes[1]?.metadata).toMatchObject({ unchanged: true });
    const reads = (await rows("state.read")).slice(before.read);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.metadata).toMatchObject({ stack: "net", serial: 1 });
    const deletes = (await rows("state.delete")).slice(before.del);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.metadata).toMatchObject({ stack: "net", versions: 1 });
  });

  test("the state's content is in no log, no audit row and no error, and only a GET with a CI token returns it", async () => {
    const token = await ciToken();
    const reader = await ciToken({ scopes: ["project.read", "state.read"] });
    const as = { authorization: basic(token) };
    seen.length = 0;
    await send("POST", at(), { ...as, body: doc(1) });
    await send("POST", at(), { ...as, body: doc(1, { serial: 0 }) });
    await send("POST", at(), { ...as, body: doc(2, { lineage: "x" }) });
    await send("POST", at(), { ...as, body: `${CANARY} not json` });
    await send("POST", at(), { authorization: basic(reader), body: doc(3) });
    await send("POST", at(), { cookie: people.admin.cookie, body: doc(3) });
    await send("GET", at(), { authorization: basic(reader) });
    await send("DELETE", at(), as);

    // what was kept in the table is sealed (proved in the db tests); here: nothing else holds it
    const everything = JSON.stringify(await t.db.select().from(auditEvents));
    expect(everything).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
    // every answer but the one 200 that returns the state itself
    expect(seen.filter((s) => s.includes(CANARY))).toEqual([doc(1)]);
  });

  test("a project that holds state cannot be deleted until the state is", async () => {
    const token = await ciToken();
    const as = { authorization: basic(token) };
    await send("POST", at(), { ...as, body: doc(1) });
    const gone = await send("DELETE", `/organizations/${ids.o1}/projects/${ids.p1}`, {
      cookie: people.admin.cookie,
    });
    expect(gone.status).toBe(409);
    expect(gone.json.code).toBe("project_has_state");
    expect(gone.text).not.toContain(CANARY);
    expect((await send("GET", at(), as)).status).toBe(200);
    await send("DELETE", at(), as);
    expect(await held()).toBe(0);
  });
});

// What Terraform's http backend sends to lock: its lock info as JSON, to `lock_address` with `lock_method` (LOCK unless
// the backend is told POST), and the same body to unlock.
const lockInfo = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ID: id,
    Operation: "OperationTypeApply",
    Info: "",
    Who: "runner@host",
    Version: "1.9.0",
    Created: "2026-10-19T10:00:00.000000Z",
    Path: "",
    ...over,
  });
const locksOf = (project = ids.p1) =>
  t.db.select().from(stateLocks).where(eq(stateLocks.projectId, project));
const clearLocks = () => t.db.delete(stateLocks);

describe("locks (STATE-4)", () => {
  test("the first job to lock holds the stack: a second is refused with the holder's lock info, which is what Terraform prints", async () => {
    await clearLocks();
    const one = { authorization: basic(await ciToken({ job: 11 })) };
    const two = { authorization: basic(await ciToken({ job: 12 })) };

    const taken = await send("LOCK", at(), {
      ...one,
      body: lockInfo("L1", { Who: "alice@runner-1" }),
    });
    expect(taken.status).toBe(200);

    const refused = await send("LOCK", at(), {
      ...two,
      body: lockInfo("L2", { Who: "bob@runner-2" }),
    });
    expect(refused.status).toBe(423);
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
    expect(refused.json).toMatchObject({
      code: "state_locked",
      ID: "L1",
      Who: "alice@runner-1",
      Operation: "OperationTypeApply",
      Version: "1.9.0",
    });
    expect(refused.json.request_id).toBeString();

    // the holder asking again with its own id is a retry
    expect((await send("LOCK", at(), { ...one, body: lockInfo("L1") })).status).toBe(200);
    expect(await locksOf()).toHaveLength(1);
  });

  test("a lock is taken and released the same way over POST and DELETE on .../lock, for a proxy that dislikes custom verbs", async () => {
    await clearLocks();
    const one = { authorization: basic(await ciToken({ job: 21 })) };
    const two = { authorization: basic(await ciToken({ job: 22 })) };
    expect((await send("POST", `${at()}/lock`, { ...one, body: lockInfo("A1") })).status).toBe(200);
    const refused = await send("POST", `${at()}/lock`, { ...two, body: lockInfo("A2") });
    expect(refused.status).toBe(423);
    expect(refused.json.ID).toBe("A1");
    // the verbs and the aliases are one lock
    expect((await send("LOCK", at(), { ...two, body: lockInfo("A3") })).status).toBe(423);
    expect((await send("DELETE", `${at()}/lock`, { ...two, body: lockInfo("A1") })).status).toBe(
      423,
    );
    expect((await send("DELETE", `${at()}/lock`, { ...one, body: lockInfo("A1") })).status).toBe(
      200,
    );
    expect((await send("LOCK", at(), { ...two, body: lockInfo("A2") })).status).toBe(200);
    expect((await send("UNLOCK", at(), { ...two, body: lockInfo("A2") })).status).toBe(200);
    expect(await locksOf()).toHaveLength(0);
  });

  test("a lock cannot be released by another job, by the holder under another id, or with no id; releasing what is not held is fine", async () => {
    await clearLocks();
    const one = { authorization: basic(await ciToken({ job: 31 })) };
    const two = { authorization: basic(await ciToken({ job: 32 })) };
    await send("LOCK", at(), { ...one, body: lockInfo("L1") });

    // job two has seen the id in a refusal and still cannot use it
    expect((await send("UNLOCK", at(), { ...two, body: lockInfo("L1") })).status).toBe(423);
    expect((await send("UNLOCK", at(), { ...one, body: lockInfo("other") })).status).toBe(423);
    expect((await send("UNLOCK", at(), one)).status).toBe(422); // no lock info at all
    expect(await locksOf()).toHaveLength(1);

    expect((await send("UNLOCK", at(), { ...one, body: lockInfo("L1") })).status).toBe(200);
    expect((await send("UNLOCK", at(), { ...one, body: lockInfo("L1") })).status).toBe(200); // nothing held now
    expect((await send("UNLOCK", at(), { ...two, body: lockInfo("L9") })).status).toBe(200);
  });

  test("while a lock is held only its holder writes, and only with its id: the state does not move for anyone else", async () => {
    await clearLocks();
    const one = { authorization: basic(await ciToken({ job: 41 })) };
    const two = { authorization: basic(await ciToken({ job: 42 })) };
    expect((await send("POST", at("dns"), { ...one, body: doc(1) })).status).toBe(200); // no lock: as before
    await send("LOCK", at("dns"), { ...one, body: lockInfo("L1") });

    for (const [who, query] of [
      [two, "?ID=L1"], // knows the id, is not the holder
      [two, ""],
      [one, ""], // the holder without its id
      [one, "?ID=other"],
    ] as const) {
      const r = await send("POST", `${at("dns")}${query}`, { ...who, body: doc(2) });
      expect(r.status).toBe(423);
      expect(r.json.code).toBe("state_locked");
    }
    expect((await send("DELETE", at("dns"), two)).status).toBe(423);
    expect((await send("GET", at("dns"), two)).text).toBe(doc(1)); // reading is never held off

    expect((await send("POST", `${at("dns")}?ID=L1`, { ...one, body: doc(2) })).status).toBe(200);
    expect((await send("GET", at("dns"), two)).text).toBe(doc(2));
    // the holder's delete needs no id: Terraform's delete sends none
    expect((await send("DELETE", at("dns"), one)).status).toBe(200);
    await send("UNLOCK", at("dns"), { ...one, body: lockInfo("L1") });
  });

  test("a lock ends with the token that took it: it is never held past it, and one whose time is up is nobody's", async () => {
    await clearLocks();
    const short = await ciToken({ job: 51, ttlMs: 90_000 });
    const token = await t.db.select().from(ciTokens).where(eq(ciTokens.gitlabJobId, 51));
    await send("LOCK", at(), { authorization: basic(short), body: lockInfo("L1") });
    const [row] = await locksOf();
    expect(row?.expiresAt.getTime()).toBe(token[0]?.expiresAt.getTime());

    const two = { authorization: basic(await ciToken({ job: 52 })) };
    expect((await send("LOCK", at(), { ...two, body: lockInfo("L2") })).status).toBe(423);
    await t.db.update(stateLocks).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await send("POST", at("dns"), { ...two, body: doc(1, { lineage: "x" }) })).status).toBe(
      200,
    );
    expect((await send("LOCK", at(), { ...two, body: lockInfo("L2") })).status).toBe(200);
    expect((await locksOf()).map((r) => r.lockId)).toEqual(["L2"]);
    await send("DELETE", at("dns"), two);
  });

  test("lock info is checked and trimmed: only what Terraform's lock info holds is kept, and a bad one is refused", async () => {
    await clearLocks();
    const as = { authorization: basic(await ciToken({ job: 61 })) };
    const two = { authorization: basic(await ciToken({ job: 62 })) };
    for (const body of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ Operation: "plan" }), // no ID
      lockInfo(""),
      lockInfo("x".repeat(257)),
      lockInfo("L1", { Who: 7 }),
      lockInfo("L1", { Created: "yesterday" }), // Terraform reads this back as a time
      lockInfo("L1", { Info: "i".repeat(5000) }),
      // a NUL is text Postgres cannot keep in a text or jsonb column: refused here, not a 500 from the database
      lockInfo("L1\u0000"),
      lockInfo("L1", { Who: "a\u0000b" }),
      lockInfo("L1", { Operation: "\u0000" }),
      lockInfo("L1", { Info: "\u0000" }),
      lockInfo("L1", { Path: "p\u0000" }),
    ]) {
      const r = await send("LOCK", at(), { ...as, body });
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("invalid_lock");
    }
    expect((await send("LOCK", at(), { ...as, body: " ".repeat(9000) })).status).toBe(413);
    expect(await locksOf()).toHaveLength(0);

    await send("LOCK", at(), { ...as, body: lockInfo("L1", { Extra: CANARY, Path: "p" }) });
    const refused = await send("LOCK", at(), { ...two, body: lockInfo("L2") });
    expect(refused.json.Path).toBe("p");
    expect(refused.text).not.toContain(CANARY);
    expect(refused.json.Extra).toBeUndefined();
    await send("UNLOCK", at(), { ...as, body: lockInfo("L1") });
  });

  test("only a job that may write can lock; a person cannot, and a lock needs a stack the project has", async () => {
    await clearLocks();
    const reader = {
      authorization: basic(await ciToken({ job: 71, scopes: ["project.read", "state.read"] })),
    };
    const writer = { authorization: basic(await ciToken({ job: 72 })) };
    for (const [method, path] of [
      ["LOCK", at()],
      ["UNLOCK", at()],
      ["POST", `${at()}/lock`],
      ["DELETE", `${at()}/lock`],
    ] as const) {
      expect((await send(method, path, { ...reader, body: lockInfo("L1") })).status).toBe(403);
      expect(
        (await send(method, path, { cookie: people.maintainer.cookie, body: lockInfo("L1") }))
          .status,
      ).toBe(403);
      expect((await send(method, path, { body: lockInfo("L1") })).status).toBe(401);
    }
    expect((await send("LOCK", at("ghost"), { ...writer, body: lockInfo("L1") })).status).toBe(403);
    expect(
      (await send("LOCK", at("net", ids.o1, ids.p2), { ...writer, body: lockInfo("L1") })).status,
    ).toBe(404);
    expect(await locksOf()).toHaveLength(0);
  });

  test("a GitHub job, which has no job id, holds the lock as its workflow run (FRG-33)", async () => {
    await clearLocks();
    const run = { authorization: basic(await ciToken({ job: null, pipeline: 8801 })) };
    expect((await send("LOCK", at(), { ...run, body: lockInfo("L1") })).status).toBe(200);
    expect((await locksOf()).map((r) => r.owner)).toEqual([`ci:${ids.p1}:run-8801`]);
    // another job of the run holds it too; another run's is turned away
    const mate = { authorization: basic(await ciToken({ job: null, pipeline: 8801 })) };
    expect((await send("LOCK", at(), { ...mate, body: lockInfo("L1") })).status).toBe(200);
    const other = { authorization: basic(await ciToken({ job: null, pipeline: 8802 })) };
    expect((await send("LOCK", at(), { ...other, body: lockInfo("L2") })).status).toBe(423);
    await send("UNLOCK", at(), { ...run, body: lockInfo("L1") });
  });

  test("a lock on a stack since taken out of the repository can still be released, by its holder or an admin", async () => {
    await clearLocks();
    const as = { authorization: basic(await ciToken({ job: 85 })) };
    const taken = (lockId: string) =>
      t.db.insert(stateLocks).values({
        organizationId: ids.o1,
        projectId: ids.p1,
        stackName: "gone",
        lockId,
        owner: `ci:${ids.p1}:job-85`,
        info: { ID: lockId },
        expiresAt: new Date(Date.now() + HOUR),
      });
    await taken("G1");
    expect((await send("UNLOCK", at("gone"), { ...as, body: lockInfo("G1") })).json).toEqual({
      released: true,
    });
    await taken("G2");
    const forced = await send("POST", `${at("gone")}/force-unlock`, {
      cookie: people.admin.cookie,
    });
    expect(forced.json).toEqual({ released: true });
    expect(await locksOf()).toHaveLength(0);
  });

  test("a lock needs no master key: it holds no state", async () => {
    await clearLocks();
    const keyless = make(false);
    const as = { authorization: basic(await ciToken({ job: 81 })), app: keyless };
    expect((await send("LOCK", at(), { ...as, body: lockInfo("L1") })).status).toBe(200);
    expect((await send("UNLOCK", at(), { ...as, body: lockInfo("L1") })).status).toBe(200);
  });

  test("an organization admin can force-unlock, and it is audited with whose lock it was; nobody else can", async () => {
    await clearLocks();
    const holder = { authorization: basic(await ciToken({ job: 91 })) };
    const other = { authorization: basic(await ciToken({ job: 92 })) };
    await send("LOCK", at(), { ...holder, body: lockInfo("L1") });
    const forced = `${at()}/force-unlock`;

    expect((await send("POST", forced, { cookie: people.maintainer.cookie })).status).toBe(403);
    expect((await send("POST", forced, holder)).status).toBe(403);
    expect((await send("POST", forced, { ...other })).status).toBe(403);
    expect((await send("POST", forced, {})).status).toBe(401);
    expect(await locksOf()).toHaveLength(1);

    const before = (await rows("state.force_unlock")).length;
    const done = await send("POST", forced, { cookie: people.admin.cookie });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ released: true });
    expect(await locksOf()).toHaveLength(0);
    const audit = await rows("state.force_unlock");
    expect(audit).toHaveLength(before + 1);
    expect(audit.at(-1)).toMatchObject({
      resourceType: "state",
      resourceId: "net",
      organizationId: ids.o1,
      projectId: ids.p1,
      metadata: { stack: "net", lockId: "L1", owner: `ci:${ids.p1}:job-91` },
    });
    // the holder's own release now finds nothing, and the next job locks
    expect((await send("UNLOCK", at(), { ...holder, body: lockInfo("L1") })).status).toBe(200);
    expect((await send("LOCK", at(), { ...other, body: lockInfo("L2") })).status).toBe(200);

    // nothing to release is still an answer, and still audited
    await clearLocks();
    const none = await send("POST", forced, { cookie: people.admin.cookie });
    expect(none.json).toEqual({ released: false });
    expect(await rows("state.force_unlock")).toHaveLength(before + 2);
    // an admin of one organization has nothing to do with another's project
    const foreign = await send("POST", `${at("net", ids.o2, ids.p2)}/force-unlock`, {
      cookie: people.admin.cookie,
    });
    expect([403, 404]).toContain(foreign.status);
  });

  test("taking and releasing are audited with the stack and the lock id; a refused lock is not", async () => {
    await clearLocks();
    const one = { authorization: basic(await ciToken({ job: 101 })) };
    const two = { authorization: basic(await ciToken({ job: 102 })) };
    const locks = (await rows("state.lock")).length;
    const unlocks = (await rows("state.unlock")).length;
    await send("LOCK", at(), { ...one, body: lockInfo("L1", { Who: "alice@runner-1" }) });
    await send("LOCK", at(), { ...two, body: lockInfo("L2") }); // refused
    await send("UNLOCK", at(), { ...two, body: lockInfo("L1") }); // refused
    await send("UNLOCK", at(), { ...one, body: lockInfo("L1") });
    const took = await rows("state.lock");
    expect(took).toHaveLength(locks + 1);
    expect(took.at(-1)?.metadata).toEqual({
      stack: "net",
      lockId: "L1",
      operation: "OperationTypeApply",
    });
    const released = await rows("state.unlock");
    expect(released).toHaveLength(unlocks + 1);
    expect(released.at(-1)?.metadata).toEqual({ stack: "net", lockId: "L1", released: true });
    expect(JSON.stringify(took)).not.toContain("alice@runner-1"); // who is shown to holders, not written to the trail
  });
});

// ---- the resource index (STATE-6): what a state holds, by name, for people who hold a role

const SECRET = "INDEX-CANARY-b81e5d-not-in-the-index";
const instance = (over: Record<string, unknown> = {}) => ({
  schema_version: 0,
  attributes: { id: "x", password: SECRET, nested: { token: SECRET } },
  sensitive_attributes: [[{ type: "get_attr", value: SECRET }]],
  private: SECRET,
  dependencies: [SECRET],
  ...over,
});
const resource = (type: string, name: string, over: Record<string, unknown> = {}) => ({
  mode: "managed",
  type,
  name,
  provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [instance()],
  ...over,
});
const listed = (path: string, query = "", cookie = people.maintainer.cookie) =>
  send("GET", `${path}/resources${query}`, { cookie });
const addresses = (r: { json: Record<string, unknown> }) =>
  (r.json.items as { address: string }[]).map((i) => i.address);
/** Writes `resources` as the stack's next state, as a job would. */
async function put(stackName: string, serial: number, resources: unknown) {
  const as = { authorization: basic(await ciToken()) };
  return send("POST", at(stackName), { ...as, body: doc(serial, { resources }) });
}
/** The stack with no state and no lock, whatever an earlier test left. */
async function fresh(stackName = "dns") {
  await t.db.delete(stateLocks).where(eq(stateLocks.stackName, stackName));
  await send("DELETE", at(stackName), { authorization: basic(await ciToken()) });
}

describe("the resource index", () => {
  test("a write indexes what is in the state by name; no attribute, output or private value is in the table or in any answer", async () => {
    await fresh();
    const written = await put("dns", 1, [
      resource("aws_route53_zone", "main"),
      resource("aws_route53_record", "www", { instances: [instance({ index_key: "eu" })] }),
    ]);
    expect(written.status).toBe(200);
    const got = await listed(at("dns"));
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      items: [
        {
          address: 'aws_route53_record.www["eu"]',
          mode: "managed",
          type: "aws_route53_record",
          name: "www",
          provider: "registry.terraform.io/hashicorp/aws",
          module: null,
          indexKey: "eu",
        },
        {
          address: "aws_route53_zone.main",
          mode: "managed",
          type: "aws_route53_zone",
          name: "main",
          provider: "registry.terraform.io/hashicorp/aws",
          module: null,
          indexKey: null,
        },
      ],
      nextCursor: null,
    });
    const table = JSON.stringify(await t.db.select().from(stateResources));
    for (const where of [table, got.text, written.text, lines.join("\n")]) {
      expect(where).not.toContain(SECRET);
      expect(where).not.toContain(CANARY); // the state's outputs
    }
    expect(JSON.stringify(await rows("state.write"))).not.toContain(SECRET);
  });

  test("the next write replaces the index; a retry and a refused write leave it as the newest version's", async () => {
    await fresh();
    await put("dns", 1, [resource("aws_route53_zone", "main")]);
    await put("dns", 2, [resource("aws_route53_zone", "main"), resource("aws_vpc", "v")]);
    expect(addresses(await listed(at("dns")))).toEqual(["aws_route53_zone.main", "aws_vpc.v"]);
    // a retry of serial 2, a serial that goes back, and the same serial with other content
    expect(
      (await put("dns", 2, [resource("aws_route53_zone", "main"), resource("aws_vpc", "v")]))
        .status,
    ).toBe(200);
    expect((await put("dns", 1, [resource("aws_subnet", "s")])).status).toBe(409);
    expect((await put("dns", 2, [resource("aws_subnet", "s")])).status).toBe(409);
    expect(addresses(await listed(at("dns")))).toEqual(["aws_route53_zone.main", "aws_vpc.v"]);
  });

  test("a state whose resources cannot be indexed is refused with 422 and writes nothing, not even over an earlier version", async () => {
    await fresh();
    await put("dns", 1, [resource("aws_route53_zone", "main")]);
    const bad: unknown[] = [
      { [SECRET]: 1 }, // resources that is not a list
      [SECRET], // a resource that is not an object
      [resource("aws_vpc", "v", { mode: SECRET })],
      [resource("aws_vpc", "v", { instances: SECRET })],
      [resource("aws_vpc", "v", { instances: [instance({ index_key: true })] })],
      [resource("aws_vpc", "v"), resource("aws_vpc", "v")], // the same instance twice
    ];
    const before = await held();
    const audits = (await rows("state.write")).length;
    for (const resources of bad) {
      const r = await put("dns", 2, resources);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("invalid_state");
      expect(r.text).not.toContain(SECRET);
    }
    expect(await held()).toBe(before);
    expect((await rows("state.write")).length).toBe(audits);
    expect(addresses(await listed(at("dns")))).toEqual(["aws_route53_zone.main"]);
    // and the next good write is still serial 2: nothing was half-written
    expect((await put("dns", 2, [resource("aws_vpc", "v")])).status).toBe(200);
  });

  test("text Postgres cannot keep (a NUL) in a lineage or a name is refused with 422, not a 500, and nothing is written", async () => {
    const as = { authorization: basic(await ciToken()) };
    const named = (over: Record<string, unknown>) => [resource("aws_vpc", "v", over)];
    const bad = [
      doc(1, { lineage: "lineage\u0000" }),
      doc(1, { resources: named({ name: "v\u0000" }) }),
      doc(1, { resources: named({ type: "aws\u0000vpc" }) }),
      doc(1, { resources: named({ module: "module.\u0000" }) }),
      doc(1, { resources: named({ provider: 'provider["x\u0000"]' }) }),
      doc(1, { resources: named({ instances: [instance({ index_key: "k\u0000" })] }) }),
    ];
    for (const body of bad) {
      await fresh();
      const r = await send("POST", at("dns"), { ...as, body });
      expect([body.slice(0, 60), r.status]).toEqual([body.slice(0, 60), 422]);
      expect(r.json.code).toBe("invalid_state");
    }
    expect((await send("GET", at("dns"), as)).status).toBe(404);
    expect(addresses(await listed(at("dns")))).toEqual([]);
  });

  test("filters by type, provider and module; the root module is module=; a value is not a pattern", async () => {
    await fresh();
    await put("dns", 1, [
      resource("aws_vpc", "main"),
      resource("aws_vpc", "peer", { module: "module.net" }),
      resource("google_dns_zone", "g", {
        provider: 'provider["registry.terraform.io/hashicorp/google"]',
      }),
    ]);
    const only = async (q: string) => addresses(await listed(at("dns"), q));
    expect(await only("?type=aws_vpc")).toEqual(["aws_vpc.main", "module.net.aws_vpc.peer"]);
    expect(await only("?provider=registry.terraform.io/hashicorp/google")).toEqual([
      "google_dns_zone.g",
    ]);
    expect(await only("?module=module.net")).toEqual(["module.net.aws_vpc.peer"]);
    expect(await only("?module=")).toEqual(["aws_vpc.main", "google_dns_zone.g"]);
    expect(await only("?type=aws_vpc&module=module.net")).toEqual(["module.net.aws_vpc.peer"]);
    expect(await only("?type=aws_%25")).toEqual([]);
  });

  test("a NUL in a filter is a 422, not a 500 from the database", async () => {
    await fresh();
    await put("dns", 1, [resource("aws_vpc", "a")]);
    for (const q of ["?type=%00", "?provider=a%00", "?module=%00"]) {
      const r = await listed(at("dns"), q);
      expect([q, r.status]).toEqual([q, 422]);
    }
    expect(addresses(await listed(at("dns"), "?type=aws_vpc"))).toEqual(["aws_vpc.a"]);
  });

  test("pages by cursor, in address order, and a bad cursor or limit is refused", async () => {
    await fresh();
    await put(
      "dns",
      1,
      ["a", "b", "c", "d", "e"].map((n) => resource("aws_vpc", n)),
    );
    const first = await listed(at("dns"), "?limit=2");
    expect(addresses(first)).toEqual(["aws_vpc.a", "aws_vpc.b"]);
    const second = await listed(at("dns"), `?limit=2&cursor=${first.json.nextCursor}`);
    expect(addresses(second)).toEqual(["aws_vpc.c", "aws_vpc.d"]);
    const last = await listed(at("dns"), `?limit=2&cursor=${second.json.nextCursor}`);
    expect(addresses(last)).toEqual(["aws_vpc.e"]);
    expect(last.json.nextCursor).toBeNull();
    expect((await listed(at("dns"), "?cursor=not-a-cursor")).status).toBe(400);
    expect((await listed(at("dns"), "?limit=0")).status).toBe(422);
    expect((await listed(at("dns"), "?limit=101")).status).toBe(422);
  });

  test("a stack with no state has an empty list; deleting the state empties it", async () => {
    await fresh();
    expect((await listed(at("dns"))).json).toEqual({ items: [], nextCursor: null });
    // a stack that is not in the scan (taken out of the repository) is listed the same: its state is still there
    expect((await listed(at("gone"))).json).toEqual({ items: [], nextCursor: null });
    await put("dns", 1, [resource("aws_vpc", "v")]);
    expect(addresses(await listed(at("dns")))).toEqual(["aws_vpc.v"]);
    await send("DELETE", at("dns"), { authorization: basic(await ciToken()) });
    expect(addresses(await listed(at("dns")))).toEqual([]);
  });

  test("a person who holds a role reads it; a job, someone with no role and another organization's admin do not", async () => {
    await fresh();
    await put("dns", 1, [resource("aws_vpc", "v")]);
    expect((await listed(at("dns"))).status).toBe(200); // a project maintainer
    expect((await listed(at("dns"), "", people.admin.cookie)).status).toBe(200); // an organization admin
    expect((await send("GET", `${at("dns")}/resources`)).status).toBe(401);
    // a job holds state.read, and is refused anyway: it has the state itself and no reason to ask
    const job = await send("GET", `${at("dns")}/resources`, {
      authorization: `Bearer ${await ciToken()}`,
    });
    expect(job.status).toBe(403);
    const crossed = await listed(at("net", ids.o2, ids.p2));
    expect([403, 404]).toContain(crossed.status);
    expect(crossed.text).not.toContain("aws_");
  });
});

// ---- the versions of a stack (STATE-10): who wrote what and when, never the content

const versionsOf = (path: string, cookie = people.maintainer.cookie) =>
  send("GET", `${path}/versions`, { cookie });
const serials = (r: { json: unknown }) => (r.json as { serial: number }[]).map((v) => v.serial);

describe("the versions of a stack", () => {
  test("newest first, with serial, lineage, size, who and when; the state, its outputs and its resources are in no answer", async () => {
    await fresh();
    for (const serial of [1, 2, 3]) {
      await put("dns", serial, [resource("aws_vpc", "v", { instances: [instance()] })]);
    }
    const got = await versionsOf(at("dns"));
    expect(got.status).toBe(200);
    expect(serials(got)).toEqual([3, 2, 1]);
    const [newest] = got.json as unknown as Record<string, unknown>[];
    expect(Object.keys(newest ?? {}).sort()).toEqual([
      "createdAt",
      "createdBy",
      "lineage",
      "serial",
      "sizeBytes",
    ]);
    expect(newest).toMatchObject({
      lineage: "lineage-1",
      createdBy: `ci:${ids.p1}:job-4242`,
      sizeBytes: Buffer.byteLength(doc(3, { resources: [resource("aws_vpc", "v")] })),
    });
    expect(new Date(String(newest?.createdAt)).toISOString()).toBe(newest?.createdAt as string);
    expect(got.text).not.toContain(CANARY);
    expect(got.text).not.toContain(SECRET);
    expect(got.text).not.toContain("aws_vpc");
  });

  test("lists every version that is kept: the newest 20, not a page of them", async () => {
    await fresh();
    for (let serial = 1; serial <= 22; serial++) await put("dns", serial, []);
    const got = await versionsOf(at("dns"));
    expect(serials(got)).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i));
  });

  test("a stack with no state, one out of the scan, and one whose state was deleted have no versions", async () => {
    await fresh();
    expect(serials(await versionsOf(at("dns")))).toEqual([]);
    expect(serials(await versionsOf(at("gone")))).toEqual([]);
    await put("dns", 1, []);
    expect(serials(await versionsOf(at("dns")))).toEqual([1]);
    await send("DELETE", at("dns"), { authorization: basic(await ciToken()) });
    expect(serials(await versionsOf(at("dns")))).toEqual([]);
  });

  test("a person who holds a role reads it; a job, nobody, and another organization's project do not", async () => {
    await fresh();
    await put("dns", 1, []);
    expect((await versionsOf(at("dns"))).status).toBe(200); // a project maintainer
    expect((await versionsOf(at("dns"), people.admin.cookie)).status).toBe(200); // an organization admin
    expect((await send("GET", `${at("dns")}/versions`)).status).toBe(401);
    const job = await send("GET", `${at("dns")}/versions`, {
      authorization: `Bearer ${await ciToken()}`,
    });
    expect(job.status).toBe(403);
    const crossed = await versionsOf(at("net", ids.o2, ids.p2));
    expect([403, 404]).toContain(crossed.status);
    expect(crossed.text).not.toContain("serial");
  });

  test("another project's versions are not listed through this project's path", async () => {
    await fresh();
    await put("dns", 1, []);
    // p2 (another organization) has a stack of the same name "net": its path never shows p1's versions
    const other = await versionsOf(at("dns", ids.o1, ids.p2));
    expect([403, 404]).toContain(other.status);
    expect(other.text).not.toContain("lineage-1");
  });
});
