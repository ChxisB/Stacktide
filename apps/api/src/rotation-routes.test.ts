import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  createVariable,
  getRotation,
  upsertUser,
  variableRotations,
  variableVersions,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { fakeRotator, type Rotator, randomRotator } from "@orch/rotation";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
/** Goes into a config and so into every value the fake provider mints: it must appear nowhere but the sealed versions. */
const CANARY = "CANARYNAME7f3a9c";

const outside = fakeRotator({ external: true });
const inside = fakeRotator({ external: false });
const rotators = new Map<string, Rotator>([
  [randomRotator.type, randomRotator],
  ["fake-out", { ...outside.rotator, type: "fake-out" }],
  ["fake-in", { ...inside.rotator, type: "fake-in" }],
  // like GitLab's token rotation: the old credential is gone in the same step
  ["fake-ends", { ...outside.rotator, type: "fake-ends", endsReplaced: true }],
]);

let t: TestDb;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "p1" | "dev" | "prod", string>;

const makeApp = (provider: typeof keys | undefined, shipped = false) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
    // the providers this build ships, when asked for
    rotators: shipped ? undefined : rotators,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "one" })).id;
  ids.o2 = (await createOrganization(t.db, { slug: "two", name: "two" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  const env = { organizationId: ids.o1, projectId: ids.p1 };
  ids.dev = (await createEnvironment(t.db, { ...env, name: "dev", slug: "dev" })).id;
  ids.prod = (
    await createEnvironment(t.db, { ...env, name: "prod", slug: "prod", protected: true })
  ).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, {
    orgRoles: { [ids.o1]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(904, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

type Who = keyof typeof people;
const seen: { path: string; text: string }[] = [];
async function call(who: Who | undefined, method: string, path: string, body?: unknown, a = app) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push({ path, text });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const O = () => `/organizations/${ids.o1}`;
const levels = {
  organization: () => `${O()}/variables`,
  project: () => `${O()}/projects/${ids.p1}/variables`,
  environment: () => `${O()}/projects/${ids.p1}/environments/${ids.dev}/variables`,
};
const actor = { kind: "user", id: "setup" };
const scopes = {
  organization: () => ({ organizationId: ids.o1 }),
  project: () => ({ organizationId: ids.o1, projectId: ids.p1 }),
  environment: () => ({ organizationId: ids.o1, projectId: ids.p1, environmentId: ids.dev }),
  protected: () => ({ organizationId: ids.o1, projectId: ids.p1, environmentId: ids.prod }),
};
let n = 0;
const secretAt = async (level: keyof typeof scopes, kind: "secret" | "plain" = "secret") =>
  (
    await createVariable(t.db, keys, {
      ...scopes[level](),
      key: `K${++n}`,
      kind,
      value: "v0",
      actor,
    })
  ).id;
const pathOf = (level: keyof typeof levels, id: string) => `${levels[level]()}/${id}/rotation`;
const rows = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const body = { provider: "random", intervalDays: 30 };

describe("who may do what", () => {
  test("a project reader sees a rotation; a maintainer sets, runs and removes it; the organization's own need an org role", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    expect((await call(undefined, "GET", url)).status).toBe(401);
    expect((await call("carol", "PUT", url, body)).status).toBe(403);
    expect((await call("bob", "PUT", url, body)).status).toBe(200);
    expect((await call("carol", "GET", url)).status).toBe(200);
    expect((await call("carol", "POST", `${url}/rotate`)).status).toBe(403);
    expect((await call("carol", "DELETE", url)).status).toBe(403);
    // another organization's admin is told nothing exists
    expect((await call("erin", "GET", url)).status).toBe(404);
    expect((await call("bob", "POST", `${url}/rotate`)).status).toBe(200);
    expect((await call("bob", "DELETE", url)).status).toBe(204);

    const org = await secretAt("organization");
    const orgUrl = pathOf("organization", org);
    // a project maintainer holds no organization rights
    expect((await call("bob", "PUT", orgUrl, body)).status).toBe(403);
    expect((await call("alice", "PUT", orgUrl, body)).status).toBe(200);
    expect((await call("bob", "POST", `${orgUrl}/rotate`)).status).toBe(403);
    expect((await call("alice", "POST", `${orgUrl}/rotate`)).status).toBe(200);
  });
});

describe("setting, reading and removing a rotation", () => {
  test.each(["organization", "project", "environment"] as const)(
    "at the %s level: set, read, change, remove, with no config in any answer",
    async (level) => {
      const id = await secretAt(level);
      const url = pathOf(level, id);
      expect((await call("alice", "GET", url)).status).toBe(404);

      const set = await call("alice", "PUT", url, {
        provider: "random",
        config: { length: 40, alphabet: "hex" },
        intervalDays: 30,
        graceDays: 3,
      });
      expect(set.status).toBe(200);
      expect(set.json).toMatchObject({
        variableId: id,
        provider: "random",
        intervalDays: 30,
        graceDays: 3,
        enabled: true,
        lastStatus: "never",
        lastAt: null,
        lastError: null,
        attempts: 0,
        revokePending: false,
      });
      expect(Object.keys(set.json)).not.toContain("config");
      expect(Object.keys(set.json)).not.toContain("handle");
      expect(set.json.nextAt).toBe((await getRotation(t.db, ids.o1, id))?.nextAt.toISOString());
      expect((await call("alice", "GET", url)).json).toEqual(set.json);

      // an update that leaves the config out keeps it; a new provider starts from none
      expect(
        (await call("alice", "PUT", url, { ...body, intervalDays: 7, enabled: false })).json,
      ).toMatchObject({ intervalDays: 7, enabled: false, graceDays: 0 });
      expect((await getRotation(t.db, ids.o1, id))?.config).toEqual({
        length: 40,
        alphabet: "hex",
      });
      await call("alice", "PUT", url, {
        provider: "fake-in",
        config: { name: "x" },
        intervalDays: 7,
      });
      expect((await getRotation(t.db, ids.o1, id))?.config).toEqual({ name: "x" });

      expect((await call("alice", "DELETE", url)).status).toBe(204);
      expect((await call("alice", "GET", url)).status).toBe(404);
      expect((await call("alice", "DELETE", url)).status).toBe(404);
    },
  );

  test("only a live secret at exactly that level has one", async () => {
    const plain = await secretAt("project", "plain");
    expect((await call("alice", "PUT", pathOf("project", plain), body)).json.code).toBe(
      "not_secret",
    );
    const envSecret = await secretAt("environment");
    // the same id under the wrong level, or a made-up one
    expect((await call("alice", "PUT", pathOf("project", envSecret), body)).status).toBe(404);
    expect((await call("alice", "PUT", pathOf("project", crypto.randomUUID()), body)).status).toBe(
      404,
    );
    expect((await call("alice", "POST", `${pathOf("project", envSecret)}/rotate`)).status).toBe(
      404,
    );
  });

  test("a bad provider, config or number is refused without echoing what was sent", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    const refused = async (over: object) => {
      const res = await call("alice", "PUT", url, { ...body, ...over });
      expect(res.status).toBe(422);
      return res;
    };
    expect((await refused({ provider: "nope" })).json.code).toBe("unknown_provider");
    expect((await refused({ provider: "Not A Slug" })).text).not.toContain("Not A Slug");
    const bad = await refused({ config: { [CANARY]: CANARY } });
    expect(bad.json.code).toBe("invalid_config");
    expect(bad.text).not.toContain(CANARY);
    await refused({ config: { length: 3 } });
    await refused({ intervalDays: 0 });
    await refused({ intervalDays: 366 });
    await refused({ graceDays: -1 });
    await refused({ intervalDays: 5, graceDays: 6 });
    await refused({ config: { padding: "x".repeat(3000) } });
    await refused({ extra: true });
    expect(await getRotation(t.db, ids.o1, id)).toBeUndefined();
  });

  test("a protected environment will not take a provider that changes something outside", async () => {
    const id = await secretAt("protected");
    const url = `${levels.environment().replace(ids.dev, ids.prod)}/${id}/rotation`;
    const out = await call("alice", "PUT", url, {
      provider: "fake-out",
      config: { name: "x" },
      intervalDays: 7,
    });
    expect(out.status).toBe(409);
    expect(out.json.code).toBe("rotation_denied");
    // one that changes nothing outside waits for approval like any other change
    expect(
      (
        await call("alice", "PUT", url, {
          provider: "fake-in",
          config: { name: "x" },
          intervalDays: 7,
        })
      ).status,
    ).toBe(200);
  });

  test("a provider that acts outside is the organization admins' to set: a project maintainer may not aim the connection", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    const out = { provider: "fake-out", config: { name: "x" }, intervalDays: 30 };
    for (const b of [out, { ...out, config: undefined }]) {
      const res = await call("bob", "PUT", url, b);
      expect([res.status, res.json.code]).toEqual([403, "forbidden"]);
    }
    expect(await getRotation(t.db, ids.o1, id)).toBeUndefined();
    // one that only changes the platform's own value stays the maintainer's, and removing is too
    const own = { provider: "fake-in", config: { name: "x" }, intervalDays: 30 };
    expect((await call("bob", "PUT", url, own)).status).toBe(200);
    expect((await call("alice", "PUT", url, out)).status).toBe(200);
    expect((await call("bob", "DELETE", url)).status).toBe(204);
  });

  test("a provider that ends the old credential itself has no grace period to set", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    const set = { provider: "fake-ends", config: { name: "x" }, intervalDays: 30 };
    const refused = await call("alice", "PUT", url, { ...set, graceDays: 3 });
    expect([refused.status, refused.json.code]).toEqual([422, "grace_unsupported"]);
    expect((await getRotation(t.db, ids.o1, id))?.provider).toBeUndefined();
    expect((await call("alice", "PUT", url, { ...set, graceDays: 0 })).status).toBe(200);
    expect((await call("alice", "PUT", url, set)).status).toBe(200);
  });

  test("the shipped gitlab-token provider takes ids, has no grace, and cannot wait for approval", async () => {
    const shipped = makeApp(keys, true);
    const id = await secretAt("project");
    const url = pathOf("project", id);
    const config = {
      connectionId: "0190f5a0-0000-7000-8000-00000000c0de",
      projectId: 7,
      tokenId: 9,
    };
    const set = { provider: "gitlab-token", config, intervalDays: 30 };
    const put = (b: unknown, path = url) => call("alice", "PUT", path, b, shipped);

    const ok = await put(set);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ provider: "gitlab-token", graceDays: 0, revokePending: false });
    expect((await getRotation(t.db, ids.o1, id))?.config).toEqual({ ...config, expiresInDays: 90 });
    // left out, the stored config stays
    expect((await put({ ...set, config: undefined, intervalDays: 14 })).status).toBe(200);
    expect((await getRotation(t.db, ids.o1, id))?.config).toMatchObject(config);

    // the token must outlast the wait for its replacement: the default lifetime is 90 days
    const long = await put({ ...set, intervalDays: 90 });
    expect([long.status, long.json.code]).toEqual([422, "interval_exceeds_lifetime"]);
    expect((await put({ ...set, intervalDays: 89 })).status).toBe(200);
    expect(
      (await put({ ...set, config: { ...config, expiresInDays: 10 }, intervalDays: 10 })).status,
    ).toBe(422);
    expect((await put({ ...set, intervalDays: 30 })).status).toBe(200);

    const grace = await put({ ...set, graceDays: 2 });
    expect([grace.status, grace.json.code]).toEqual([422, "grace_unsupported"]);
    const bad = await put({ ...set, config: { ...config, tokenId: CANARY } });
    expect([bad.status, bad.json.code]).toEqual([422, "invalid_config"]);
    expect(bad.text).not.toContain(CANARY);
    // a new rotation needs the ids: nothing is stored for a provider with none
    const bare = await secretAt("project");
    expect(
      (await put({ provider: "gitlab-token", intervalDays: 30 }, pathOf("project", bare))).status,
    ).toBe(422);
    expect(await getRotation(t.db, ids.o1, bare)).toBeUndefined();
    // protected: GitLab's rotation ends the live token before anyone approves
    const prod = await secretAt("protected");
    const refused = await put(
      set,
      `${O()}/projects/${ids.p1}/environments/${ids.prod}/variables/${prod}/rotation`,
    );
    expect([refused.status, refused.json.code]).toEqual([409, "rotation_denied"]);
  });

  test("while a replaced credential awaits its revoke, the provider and config stay and the rotation stays", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    const set = { provider: "fake-out", config: { name: "x" }, intervalDays: 30, graceDays: 5 };
    expect((await call("alice", "PUT", url, set)).status).toBe(200);
    await t.db
      .update(variableRotations)
      .set({ handle: "h2", previousHandle: "h1", revokeAt: new Date(Date.now() + 86_400_000) })
      .where(eq(variableRotations.variableId, id));

    expect((await call("alice", "GET", url)).json).toMatchObject({ revokePending: true });
    for (const change of [
      { provider: "fake-in" },
      { config: { name: "y" } },
      { provider: "random", config: {} },
    ]) {
      const res = await call("alice", "PUT", url, { ...set, ...change });
      expect([res.status, res.json.code]).toEqual([409, "revoke_pending"]);
    }
    expect((await call("alice", "DELETE", url)).json.code).toBe("revoke_pending");
    // what does not touch the credential's reach may change, and so may switching it off
    const ok = await call("alice", "PUT", url, { ...set, intervalDays: 60, enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ intervalDays: 60, enabled: false, revokePending: true });
    expect((await getRotation(t.db, ids.o1, id))?.previousHandle).toBe("h1");
  });
});

describe("rotating now", () => {
  test("makes the next version, says so, and never shows the value", async () => {
    const id = await secretAt("environment");
    const url = pathOf("environment", id);
    await call("alice", "PUT", url, {
      provider: "fake-in",
      config: { name: "plain" },
      intervalDays: 30,
    });

    const run = await call("bob", "POST", `${url}/rotate`);
    expect(run.status).toBe(200);
    expect(run.json).toEqual({ result: "rotated", version: 2 });
    expect(run.text).not.toContain("plain-secret");
    const after = (await call("alice", "GET", url)).json;
    expect(after).toMatchObject({ lastStatus: "ok", attempts: 0 });
    expect(Date.parse(after.nextAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // a person asked, and the rotation did it: both are on record
    const asked = (await rows("variable.rotation.run")).filter((r) => r.resourceId === id);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ actorKind: "user", actorId: people.bob.id });
    expect(asked[0]?.metadata).toMatchObject({ key: expect.any(String), result: "rotated" });
    const did = (await rows("variable.rotate")).filter((r) => r.resourceId === id);
    expect(did).toHaveLength(1);
    expect(did[0]?.actorKind).toBe("rotation");
  });

  test("a protected environment's new value waits for approval", async () => {
    const id = await secretAt("protected");
    const url = `${levels.environment().replace(ids.dev, ids.prod)}/${id}/rotation`;
    await call("alice", "PUT", url, {
      provider: "fake-in",
      config: { name: "p" },
      intervalDays: 30,
    });
    const run = await call("alice", "POST", `${url}/rotate`);
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ result: "waiting", changeRequestId: expect.any(String) });
    expect((await call("alice", "GET", url)).json.lastStatus).toBe("pending_approval");
  });

  test("a provider that fails keeps the old value, is counted and backed off, and its text goes nowhere", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    await call("alice", "PUT", url, {
      provider: "fake-in",
      config: { name: "f" },
      intervalDays: 30,
    });
    inside.failWith("failed");
    const run = await call("alice", "POST", `${url}/rotate`);
    inside.failWith(null);
    expect(run.status).toBe(502);
    expect(run.json.code).toBe("rotation_failed");
    expect(run.text).not.toContain("told to fail");
    const row = await getRotation(t.db, ids.o1, id);
    expect(row).toMatchObject({ lastError: "failed", attempts: 1 });
    // backed off 10 minutes, not the interval
    expect((row?.nextAt.getTime() ?? 0) - Date.now()).toBeLessThan(11 * 60_000);
    const versions = await t.db
      .select()
      .from(variableVersions)
      .where(eq(variableVersions.variableId, id));
    expect(versions).toHaveLength(1);
    const asked = (await rows("variable.rotation.run")).filter((r) => r.resourceId === id);
    expect(asked[0]?.metadata).toMatchObject({ code: "failed" });
  });

  test("a config the provider no longer accepts is a 422 and a refused provider a 409", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    await call("alice", "PUT", url, { ...body });
    await t.db
      .update(variableRotations)
      .set({ config: { length: 1 } })
      .where(eq(variableRotations.variableId, id));
    const bad = await call("alice", "POST", `${url}/rotate`);
    expect([bad.status, bad.json.code]).toEqual([422, "invalid_config"]);
    await t.db
      .update(variableRotations)
      .set({ config: {} })
      .where(eq(variableRotations.variableId, id));
    outside.failWith("denied");
    const id2 = await secretAt("project");
    await call("alice", "PUT", pathOf("project", id2), {
      provider: "fake-out",
      config: { name: "d" },
      intervalDays: 30,
    });
    const denied = await call("alice", "POST", `${pathOf("project", id2)}/rotate`);
    outside.failWith(null);
    expect([denied.status, denied.json.code]).toEqual([409, "rotation_denied"]);
  });

  test("without master keys it answers 503, and a rotation that is not set 404", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    expect((await call("alice", "POST", `${url}/rotate`)).json.code).toBe("not_found");
    const keyless = makeApp(undefined);
    expect((await call("alice", "POST", `${url}/rotate`, undefined, keyless)).status).toBe(503);
  });
});

describe("what is audited, and what must never leak", () => {
  test("every change is on record by names and numbers, and nothing secret is anywhere", async () => {
    const id = await secretAt("project");
    const url = pathOf("project", id);
    await call("alice", "PUT", url, {
      provider: "fake-in",
      config: { name: CANARY },
      intervalDays: 30,
    });
    expect((await call("alice", "POST", `${url}/rotate`)).status).toBe(200);
    expect((await call("alice", "POST", `${url}/rotate`)).status).toBe(200);
    expect((await call("alice", "GET", url)).status).toBe(200);
    expect((await call("alice", "GET", `${levels.project()}/${id}`)).status).toBe(200);
    expect((await call("alice", "GET", levels.project())).status).toBe(200);
    expect((await call("alice", "DELETE", url)).status).toBe(204);

    const mine = async (action: string) => (await rows(action)).filter((r) => r.resourceId === id);
    const set = await mine("variable.rotation.set");
    expect(set).toHaveLength(1);
    expect(set[0]?.metadata).toMatchObject({
      level: "project",
      provider: "fake-in",
      intervalDays: 30,
      graceDays: 0,
      enabled: true,
    });
    expect(await mine("variable.rotation.delete")).toHaveLength(1);
    expect(await mine("variable.rotation.run")).toHaveLength(2);

    // the config and what the provider made are in the sealed versions and the rotation row only
    const audits = JSON.stringify(await t.db.select().from(auditEvents));
    expect(audits).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
    for (const s of seen) expect([s.path, s.text.includes(CANARY)]).toEqual([s.path, false]);
    // the check can fail: the provider did put the canary in what it minted, and a reveal shows it
    const revealed = await call("alice", "GET", `${levels.project()}/${id}/value`);
    expect(revealed.text).toContain(`${CANARY}-secret-`);
  });
});
