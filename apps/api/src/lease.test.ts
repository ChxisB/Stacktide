import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, DomainError, LEASES_PER_PRINCIPAL } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  audit,
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  getLease,
  LEASE_SWEEP_QUEUE,
  type Lease,
  secretLeases,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { type Leaser, RotationError } from "@orch/rotation";
import { eq } from "drizzle-orm";
import { issueLease, type LeaseDeps, leaseSweepHandler, revokeLease, sweepLeases } from "./lease";
import { builtInLeasers } from "./rotators";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = new Date("2030-03-01T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let t: TestDb;
let mock: MockGitlab;
let lines: string[];
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  // the sweeper looks at every organization: leases left by an earlier test (whose GitLab is gone) would fail it
  await t.db.delete(secretLeases);
  mock?.stop();
  mock = createMockGitlab();
  lines = [];
});

const logger = () => createLogger({ level: "debug", write: (l) => lines.push(l) });
const deps = (over: Partial<LeaseDeps> = {}): LeaseDeps => ({
  db: t.db,
  leasers: builtInLeasers({ db: t.db, keys, logger: logger() }),
  logger: logger(),
  ...over,
});

let n = 0;
/** An organization with a GitLab connection to the mock and a project linked to a project on it. */
async function world(opts: { connection?: "other-org" } = {}) {
  const org = await createOrganization(t.db, { slug: `le${++n}`, name: "L" });
  const stranger = await createOrganization(t.db, { slug: `ls${n}`, name: "S" });
  const gl = mock.addProject({ path: `platform/p${n}` });
  const project = await createProject(t.db, {
    organizationId: org.id,
    name: `p${n}`,
    gitlabProjectId: gl.id,
  });
  const connection = await createConnection(t.db, keys, {
    organizationId: opts.connection === "other-org" ? stranger.id : org.id,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  const principal = `user:u${n}`;
  const input = (over: Partial<Parameters<typeof issueLease>[1]> = {}) => ({
    organizationId: org.id,
    projectId: project.id,
    remoteProjectId: gl.id,
    connectionId: connection.id,
    provider: "gitlab-token",
    scopes: ["read_repository"],
    principal,
    now: T0,
    ...over,
  });
  const record = (tx: Parameters<Parameters<typeof issueLease>[2]>[0], lease: Lease) =>
    audit(
      tx,
      { actor: { kind: "user", id: principal } },
      {
        action: "lease.issue",
        resourceType: "lease",
        resourceId: lease.id,
        organizationId: org.id,
        projectId: project.id,
        metadata: { provider: lease.provider, scopes: lease.scopes },
      },
    );
  const issue = (over: Partial<Parameters<typeof issueLease>[1]> = {}) =>
    issueLease(deps(), input(over), record);
  const row = async (id: string) => {
    const r = await getLease(t.db, org.id, project.id, id);
    if (!r) throw new Error("no lease");
    return r;
  };
  const events = (action: string) =>
    t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, org.id))
      .then((all) => all.filter((e) => e.action === action));
  return { org, project, gl, connection, principal, input, record, issue, row, events };
}

const requests = () => mock.requests.map((r) => `${r.method} ${r.path}`);
const tokenCalls = () => requests().filter((r) => r.includes("/access_tokens"));

describe("leases", () => {
  test("a lease is a read-only token for the project, shown once and kept nowhere", async () => {
    const w = await world();
    const { lease, value } = await w.issue({ scopes: ["read_api", "read_repository"] });
    expect(value).toMatch(/^glpat-/);
    expect(mock.accessTokenValid(value)).toBe(true);
    expect(lease).toMatchObject({
      provider: "gitlab-token",
      principal: w.principal,
      remoteProjectId: w.gl.id,
      scopes: "read_api,read_repository",
      revokedAt: null,
    });
    expect(lease.expiresAt).toEqual(at(HOUR));
    expect(lease.handle).toMatch(/^\d+$/);
    // the one handle is named for the lease, and GitLab knows it as that
    expect(mock.accessTokenValid(value)).toBe(true);

    // canary: the value is in no row, no audit event and no log
    const stored = JSON.stringify(await t.db.select().from(secretLeases));
    const events = JSON.stringify(await t.db.select().from(auditEvents));
    for (const text of [stored, events, lines.join("\n")]) expect(text.includes(value)).toBe(false);
    expect(await w.events("lease.issue")).toHaveLength(1);
    expect((await w.row(lease.id)).handle).toBe(lease.handle);
  });

  test("the lifetime comes from the request within the limits, and nothing asks GitLab when it is refused", async () => {
    const w = await world();
    const short = await w.issue({ ttlSeconds: 120 });
    expect(short.lease.expiresAt).toEqual(at(2 * MIN));
    const long = await w.issue({ ttlSeconds: 86_400 });
    expect(long.lease.expiresAt).toEqual(at(24 * HOUR));
    const before = tokenCalls().length;

    for (const ttlSeconds of [59, 86_401, 0, -1, 1.5, Number.NaN]) {
      const e = await w.issue({ ttlSeconds }).catch((x) => x);
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ code: "invalid_ttl", status: 422 });
    }
    for (const scopes of [["api"], ["read_repository", "write_repository"], []]) {
      const e = await w.issue({ scopes }).catch((x) => x);
      expect(e).toMatchObject({ code: "invalid_scope", status: 422 });
    }
    const unknown = await w.issue({ provider: "postgres-role" }).catch((x) => x);
    expect(unknown).toMatchObject({ code: "unknown_provider", status: 422 });
    expect(tokenCalls()).toHaveLength(before);
  });

  test("a principal holds a limited number of live leases; the refused one made nothing", async () => {
    const w = await world();
    for (let i = 0; i < LEASES_PER_PRINCIPAL; i++) await w.issue();
    const made = tokenCalls().length;
    const e = await w.issue().catch((x) => x);
    expect(e).toMatchObject({ code: "too_many_leases", status: 429 });
    expect(tokenCalls()).toHaveLength(made);
    // an hour on they have all expired
    await w.issue({ now: at(HOUR + MIN) });
  });

  test("a provider that fails leaves no lease behind, and says why without any value", async () => {
    const w = await world({ connection: "other-org" });
    const e = await w.issue().catch((x) => x);
    expect(e).toBeInstanceOf(RotationError);
    expect(e.kind).toBe("denied");
    expect(
      await t.db.select().from(secretLeases).where(eq(secretLeases.organizationId, w.org.id)),
    ).toEqual([]);
    expect(tokenCalls()).toHaveLength(0);
  });

  test("if recording fails the token is revoked and the lease dropped", async () => {
    const w = await world();
    const boom = new Error("audit store is down");
    const e = await issueLease(deps(), w.input(), async () => {
      throw boom;
    }).catch((x) => x);
    expect(e).toBe(boom);
    expect(
      await t.db.select().from(secretLeases).where(eq(secretLeases.organizationId, w.org.id)),
    ).toEqual([]);
    // GitLab made one token and it is dead: the DELETE followed the POST
    expect(tokenCalls().map((r) => r.split(" ")[0])).toEqual(["POST", "DELETE"]);
  });

  test("if recording fails and the revoke does too, the lease stays with its credential for the sweeper", async () => {
    const w = await world();
    const real = builtInLeasers({ db: t.db, keys, logger: logger() }).get("gitlab-token");
    if (!real) throw new Error("no gitlab-token leaser");
    const flaky: Leaser = {
      ...real,
      revoke: async () => {
        throw new RotationError("failed", "gitlab-token: GitLab did not revoke the token (server)");
      },
    };
    const boom = new Error("audit store is down");
    const e = await issueLease(
      deps({ leasers: new Map([["gitlab-token", flaky]]) }),
      w.input(),
      async () => {
        throw boom;
      },
    ).catch((x) => x);
    expect(e).toBe(boom);
    const [left, ...more] = await t.db
      .select()
      .from(secretLeases)
      .where(eq(secretLeases.organizationId, w.org.id));
    expect(more).toEqual([]);
    // nothing dropped the only record of the credential: its handle is on the row
    expect(left?.handle).toMatch(/^\d+$/);
    expect(left?.revokedAt).toBeNull();

    const swept = await sweepLeases(deps(), { now: at(2 * HOUR) });
    expect(swept).toMatchObject({ revoked: 1, failed: 0 });
    expect(tokenCalls().map((r) => r.split(" ")[0])).toEqual(["POST", "DELETE"]);
  });

  test("revoking on request ends the token and the lease, once", async () => {
    const w = await world();
    const { lease, value } = await w.issue();
    const ended: string[] = [];
    const record = async (_tx: unknown, l: Lease) => void ended.push(l.id);

    expect(await revokeLease(deps(), lease, record, at(5 * MIN))).toBe("revoked");
    expect(mock.accessTokenValid(value)).toBe(false);
    const after = await w.row(lease.id);
    expect(after.revokedAt).toEqual(at(5 * MIN));

    expect(await revokeLease(deps(), after, record)).toBe("already");
    // a stale copy that still thinks it is live: GitLab is asked again (idempotent), the row ends once
    expect(await revokeLease(deps(), lease, record, at(9 * MIN))).toBe("already");
    expect(ended).toEqual([lease.id]);
    expect((await w.row(lease.id)).revokedAt).toEqual(at(5 * MIN));
  });

  test("a revoke the provider cannot do leaves the lease live, to be tried again", async () => {
    const w = await world();
    const { lease } = await w.issue();
    const down: Leaser = {
      type: "gitlab-token",
      issue: async () => {
        throw new Error("not here");
      },
      revoke: async () => {
        throw new RotationError("failed", "gitlab-token: GitLab did not revoke the token (server)");
      },
    };
    const e = await revokeLease(
      deps({ leasers: new Map([["gitlab-token", down]]) }),
      lease,
      async () => {},
    ).catch((x) => x);
    expect(e).toBeInstanceOf(RotationError);
    expect((await w.row(lease.id)).revokedAt).toBeNull();
  });

  test("a lease that never recorded its credential cannot be revoked from here", async () => {
    const w = await world();
    const { lease } = await w.issue();
    const e = await revokeLease(deps(), { ...lease, handle: null }, async () => {}).catch((x) => x);
    expect(e).toMatchObject({ code: "lease_unrevocable", status: 409 });
  });
});

describe("the sweeper", () => {
  test("ends a lease at its expiry and not before, and a second sweep does nothing", async () => {
    const w = await world();
    const a = await w.issue({ ttlSeconds: 600 });
    const b = await w.issue({ ttlSeconds: 7200 });

    expect(await sweepLeases(deps(), { now: at(9 * MIN) })).toEqual({ revoked: 0, failed: 0 });
    expect(mock.accessTokenValid(a.value)).toBe(true);

    expect(await sweepLeases(deps(), { now: at(11 * MIN) })).toEqual({ revoked: 1, failed: 0 });
    expect(mock.accessTokenValid(a.value)).toBe(false);
    expect(mock.accessTokenValid(b.value)).toBe(true);
    expect((await w.row(a.lease.id)).revokedAt).toEqual(at(11 * MIN));
    expect((await w.row(b.lease.id)).revokedAt).toBeNull();

    const before = requests().length;
    expect(await sweepLeases(deps(), { now: at(12 * MIN) })).toEqual({ revoked: 0, failed: 0 });
    expect(requests()).toHaveLength(before);

    const expired = await w.events("lease.expire");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      actorKind: "system",
      actorId: "lease-sweep",
      resourceId: a.lease.id,
    });
    expect(JSON.stringify(expired).includes(a.value)).toBe(false);
  });

  test("a revoke by a person and the sweeper at the same moment end it once", async () => {
    const w = await world();
    const { lease, value } = await w.issue({ ttlSeconds: 60 });
    const late = at(2 * MIN);
    const [swept, revoked] = await Promise.all([
      sweepLeases(deps(), { now: late }),
      revokeLease(deps(), lease, async () => {}, late),
    ]);
    expect(swept.failed).toBe(0);
    expect(swept.revoked + (revoked === "revoked" ? 1 : 0)).toBe(1);
    expect(mock.accessTokenValid(value)).toBe(false);
  });

  test("a provider error leaves the lease for the next sweep and never stops the others", async () => {
    const w = await world();
    const a = await w.issue({ ttlSeconds: 60 });
    const b = await w.issue({ ttlSeconds: 60 });
    const real = builtInLeasers({ db: t.db, keys, logger: logger() }).get("gitlab-token") as Leaser;
    let failing = true;
    const flaky: Leaser = {
      ...real,
      revoke: (target, handle, scope) =>
        failing && handle === a.lease.handle
          ? Promise.reject(new RotationError("failed", "gitlab-token: GitLab did not revoke it"))
          : real.revoke(target, handle, scope),
    };
    const flakyDeps = deps({ leasers: new Map([["gitlab-token", flaky]]) });

    expect(await sweepLeases(flakyDeps, { now: at(2 * MIN) })).toEqual({ revoked: 1, failed: 1 });
    expect(mock.accessTokenValid(a.value)).toBe(true);
    expect(mock.accessTokenValid(b.value)).toBe(false);
    expect((await w.row(a.lease.id)).revokedAt).toBeNull();
    expect(lines.some((l) => l.includes("lease could not be revoked at expiry"))).toBe(true);
    expect(lines.join("\n").includes(a.value)).toBe(false);

    failing = false;
    expect(await sweepLeases(flakyDeps, { now: at(3 * MIN) })).toEqual({ revoked: 1, failed: 0 });
    expect(mock.accessTokenValid(a.value)).toBe(false);
    expect((await w.row(a.lease.id)).revokedAt).toEqual(at(3 * MIN));
  });

  test("a lease whose token GitLab no longer has is ended, not retried forever", async () => {
    const w = await world();
    const { lease } = await w.issue({ ttlSeconds: 60 });
    // someone revoked it at GitLab already: the revoke finds nothing, which is done
    await createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    }).accessTokens.revoke(w.gl.id, Number(lease.handle));
    expect(await sweepLeases(deps(), { now: at(2 * MIN) })).toEqual({ revoked: 1, failed: 0 });
    expect((await w.row(lease.id)).revokedAt).toEqual(at(2 * MIN));
  });

  test("the lease.sweep job ends expired leases on its own, whether or not rotation runs", async () => {
    const w = await world();
    const { lease, value } = await w.issue({ ttlSeconds: 60 });
    const ctx: JobContext = {
      id: "0198d6f0-0000-7000-8000-000000000002",
      queue: LEASE_SWEEP_QUEUE,
      payload: {},
      attempt: 1,
      maxAttempts: 3,
      log: logger(),
      signal: new AbortController().signal,
    };
    const sweep = (over: Partial<LeaseDeps> = {}) =>
      leaseSweepHandler({ ...deps(over), now: () => at(2 * MIN) })(ctx);

    expect(LEASE_SWEEP_QUEUE).toBe("lease.sweep");
    await sweep({ leasers: new Map() }); // no provider for it: left for a later sweep, and the job still ends
    expect(mock.accessTokenValid(value)).toBe(true);
    await sweep();
    expect(mock.accessTokenValid(value)).toBe(false);
    expect((await w.row(lease.id)).revokedAt).not.toBeNull();
  });
});
