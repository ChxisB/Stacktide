import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { AuthStoreError } from "./auth";
import { createCiToken, environmentBySlug, projectsByGitlabId, useCiToken } from "./ci";
import { pgConstraint } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteEnvironment,
  deleteProject,
} from "./repo";
import { ciTokens } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
const hash = () => (++n).toString(16).padStart(64, "0");
async function scene(gitlabProjectId = 9000 + ++n) {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: "p", gitlabProjectId });
  const env = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Staging",
    slug: "staging",
  });
  return { org, project, env };
}
async function issue(over: Partial<Parameters<typeof createCiToken>[1]> = {}) {
  const s = await scene();
  const tokenHash = hash();
  const row = await createCiToken(t.db, {
    organizationId: s.org.id,
    projectId: s.project.id,
    environmentId: s.env.id,
    tokenHash,
    scopes: ["project.read"],
    gitlabProjectId: 1,
    ref: "main",
    refProtected: true,
    ttlMs: 60_000,
    ...over,
  });
  return { ...s, row, tokenHash };
}

describe("createCiToken", () => {
  test("stores the hash, never anything usable as the token, and expires on the database clock", async () => {
    const { row, tokenHash } = await issue({ gitlabJobId: 77, ref: "release/1" });
    expect(row).toMatchObject({
      tokenHash,
      scopes: ["project.read"],
      gitlabJobId: 77,
      ref: "release/1",
      refProtected: true,
    });
    const [{ left }] = (await t.db.execute(
      sql`select extract(epoch from (expires_at - now())) as left from ci_tokens where id = ${row.id}`,
    )) as unknown as [{ left: string }];
    expect(Number(left)).toBeGreaterThan(55);
    expect(Number(left)).toBeLessThanOrEqual(60);
  });

  test("only a SHA-256 digest may be stored, and the lifetime is one second to one hour", async () => {
    const s = await scene();
    const base = {
      organizationId: s.org.id,
      projectId: s.project.id,
      scopes: [],
      gitlabProjectId: 1,
      ref: "main",
      refProtected: false,
    };
    for (const tokenHash of ["", "orchci_abcdefgh.secret", "G".repeat(64), "a".repeat(63)]) {
      await expect(createCiToken(t.db, { ...base, tokenHash, ttlMs: 1000 })).rejects.toBeInstanceOf(
        AuthStoreError,
      );
    }
    for (const ttlMs of [0, 999, 3_600_001, 1.5, Number.NaN]) {
      await expect(
        createCiToken(t.db, { ...base, tokenHash: hash(), ttlMs }),
      ).rejects.toBeInstanceOf(AuthStoreError);
    }
    expect(await createCiToken(t.db, { ...base, tokenHash: hash(), ttlMs: 1000 })).toBeDefined();
    expect(
      await createCiToken(t.db, { ...base, tokenHash: hash(), ttlMs: 3_600_000 }),
    ).toBeDefined();
  });

  test("a hash is stored once", async () => {
    const { tokenHash, org, project } = await issue();
    const error = await createCiToken(t.db, {
      organizationId: org.id,
      projectId: project.id,
      tokenHash,
      scopes: [],
      gitlabProjectId: 1,
      ref: "main",
      refProtected: false,
      ttlMs: 1000,
    }).catch((e) => e);
    expect(pgConstraint(error)).toBe("ci_tokens_token_hash_key");
  });

  test("a token cannot name an organization other than its project's", async () => {
    const a = await scene();
    const b = await scene();
    const error = await createCiToken(t.db, {
      organizationId: b.org.id,
      projectId: a.project.id,
      tokenHash: hash(),
      scopes: [],
      gitlabProjectId: 1,
      ref: "main",
      refProtected: false,
      ttlMs: 1000,
    }).catch((e) => e);
    expect(pgConstraint(error)).toBe("ci_tokens_project_org_fk");
  });

  test("tokens that expired over a day ago go on the next issue; newer ones stay", async () => {
    const old = await issue();
    const recent = await issue();
    await t.db
      .update(ciTokens)
      .set({ expiresAt: sql`now() - interval '2 days'` })
      .where(eq(ciTokens.id, old.row.id));
    await t.db
      .update(ciTokens)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(ciTokens.id, recent.row.id));
    await issue();
    const left = await t.db.select({ id: ciTokens.id }).from(ciTokens);
    expect(left.map((r) => r.id)).toContain(recent.row.id);
    expect(left.map((r) => r.id)).not.toContain(old.row.id);
  });

  test("tokens go with their project and with their environment", async () => {
    const gone = await issue();
    await deleteEnvironment(t.db, gone.org.id, gone.project.id, gone.env.id);
    expect(await useCiToken(t.db, gone.tokenHash)).toBeUndefined();
    const other = await issue();
    await deleteProject(t.db, other.org.id, other.project.id);
    expect(await useCiToken(t.db, other.tokenHash)).toBeUndefined();
  });
});

describe("useCiToken", () => {
  test("a live token is found", async () => {
    const { tokenHash, row } = await issue();
    expect(await useCiToken(t.db, tokenHash)).toEqual(row);
  });

  test("an expired, unknown or malformed one is not", async () => {
    const { tokenHash, row } = await issue();
    await t.db
      .update(ciTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(ciTokens.id, row.id));
    expect(await useCiToken(t.db, tokenHash)).toBeUndefined();
    expect(await useCiToken(t.db, hash())).toBeUndefined();
    await expect(useCiToken(t.db, "orchci_abcdefgh.secret")).rejects.toBeInstanceOf(AuthStoreError);
  });
});

describe("lookups", () => {
  test("projectsByGitlabId: none, one, and at most two when it is ambiguous", async () => {
    const id = 424_242;
    expect(await projectsByGitlabId(t.db, id)).toEqual([]);
    const a = await scene(id);
    expect(await projectsByGitlabId(t.db, id)).toEqual([
      { id: a.project.id, organizationId: a.org.id },
    ]);
    await scene(id);
    await scene(id);
    expect(await projectsByGitlabId(t.db, id)).toHaveLength(2);
  });

  test("environmentBySlug is scoped to the project", async () => {
    const a = await scene();
    const b = await scene();
    expect(await environmentBySlug(t.db, a.project.id, "staging")).toEqual({ id: a.env.id });
    expect(await environmentBySlug(t.db, b.project.id, "staging")).toEqual({ id: b.env.id });
    expect(await environmentBySlug(t.db, a.project.id, "production")).toBeUndefined();
    expect(await environmentBySlug(t.db, a.project.id, "Staging")).toBeUndefined();
  });
});
