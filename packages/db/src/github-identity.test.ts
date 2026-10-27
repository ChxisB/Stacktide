import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import { createConnection } from "./connections";
import { importProject } from "./imports";
import { pgConstraint } from "./pg-error";
import { createOrganization, githubLinks, githubOrgLinks } from "./repo";
import { userIdentities, users } from "./schema";
import {
  createSsoProvider,
  githubIdOf,
  listIdentities,
  listOwnIdentities,
  signInGithub,
  signInSso,
  unlinkIdentity,
} from "./sso";
import { createTestDb, type TestDb } from "./testing";

// FRG-25: a GitHub account as a way to sign in, and the repositories whose collaborators it speaks for.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
let n = 0;
const org = () => createOrganization(t.db, { slug: `g${++n}`, name: "G" });
const who = (over: Partial<{ githubId: number; login: string; name: string }> = {}) => ({
  githubId: 4242,
  login: "ada",
  name: "Ada",
  ...over,
});

describe("signing in with GitHub", () => {
  test("a first sign-in makes a person with no GitLab id and one github identity; the next finds the same person", async () => {
    const first = await signInGithub(t.db, who({ githubId: 1001 }));
    expect(first).toMatchObject({ gitlabId: null, username: "ada", name: "Ada" });
    expect(await listIdentities(t.db, first.id)).toMatchObject([
      { provider: "github", subject: "1001", ssoProviderId: null, email: null },
    ]);
    // GitHub lets a person rename themselves: the id is the identity, the login is only what we show
    const again = await signInGithub(t.db, who({ githubId: 1001, login: "ada-l", name: "Ada L" }));
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ username: "ada-l", name: "Ada L" });
    expect(await t.db.select().from(users).where(eq(users.id, first.id))).toHaveLength(1);
  });

  test("a person who also signs in with GitLab keeps the username and name GitLab gave", async () => {
    const first = await signInGithub(t.db, who({ githubId: 1010, login: "gh-name", name: "GH" }));
    await t.db
      .insert(userIdentities)
      .values({ userId: first.id, provider: "gitlab", subject: "910", ssoProviderId: null });
    const again = await signInGithub(t.db, who({ githubId: 1010, login: "renamed", name: "R" }));
    expect(again).toMatchObject({ id: first.id, username: "gh-name", name: "GH" });
  });

  test("the same login on another id is another person: nothing but the id matches", async () => {
    const a = await signInGithub(t.db, who({ githubId: 1002, login: "same" }));
    const b = await signInGithub(t.db, who({ githubId: 1003, login: "same" }));
    expect(a.id).not.toBe(b.id);
  });

  test("a GitHub id and a provider's subject of the same text are not the same person", async () => {
    const p = await createSsoProvider(t.db, keys, {
      organizationId: (await org()).id,
      issuer: "https://idp.example.com",
      clientId: "orch",
      clientSecret: "idp-client-SECRET-0123456789",
      emailDomains: [],
      roleMap: [],
    });
    const sso = await signInSso(t.db, p.id, {
      subject: "1004",
      email: "a@x.example",
      username: "u",
      name: "U",
    });
    const gh = await signInGithub(t.db, who({ githubId: 1004 }));
    expect(gh.id).not.toBe(sso.id);
  });

  test("sign-ins at the same moment make one person", async () => {
    const people = await Promise.all(
      [1, 2, 3].map(() => t.db.transaction((tx) => signInGithub(tx, who({ githubId: 1005 })))),
    );
    expect(new Set(people.map((p) => p.id)).size).toBe(1);
    expect(
      await t.db.select().from(userIdentities).where(eq(userIdentities.subject, "1005")),
    ).toHaveLength(1);
  });

  test("the person's GitHub id is found for roles, and a person with none has none", async () => {
    const gh = await signInGithub(t.db, who({ githubId: 1006 }));
    expect(await githubIdOf(t.db, gh.id)).toBe(1006);
    const other = await t.db
      .insert(users)
      .values({ gitlabId: 77, username: "gl", name: "GL" })
      .returning();
    expect(await githubIdOf(t.db, other[0]?.id ?? "")).toBeUndefined();
  });

  test("it shows as a github way in, with no subject, and is the account's own: it is not given up", async () => {
    const gh = await signInGithub(t.db, who({ githubId: 1007 }));
    const [mine] = await listOwnIdentities(t.db, gh.id);
    expect(mine).toMatchObject({ kind: "github", organizationSlug: null, email: null });
    expect(JSON.stringify(mine)).not.toContain("1007");
    expect(await unlinkIdentity(t.db, gh.id, mine?.id ?? "")).toEqual({ status: "github" });
  });

  test("the table refuses a github identity that names an identity provider, and a provider it does not know", async () => {
    const gh = await signInGithub(t.db, who({ githubId: 1008 }));
    const p = await createSsoProvider(t.db, keys, {
      organizationId: (await org()).id,
      issuer: "https://idp.example.com",
      clientId: "orch",
      clientSecret: "idp-client-SECRET-0123456789",
      emailDomains: [],
      roleMap: [],
    });
    const attempt = (provider: string, ssoProviderId: string | null) =>
      t.db
        .insert(userIdentities)
        .values({ userId: gh.id, provider, subject: "x", ssoProviderId })
        .then(
          () => undefined,
          (e) => pgConstraint(e),
        );
    expect(await attempt("github", p.id)).toBe("user_identities_provider_check");
    expect(await attempt("gitlab-ish", null)).toBe("user_identities_provider_check");
    await t.db.execute(sql`DELETE FROM user_identities WHERE subject = 'x'`);
  });
});

describe("the repositories a GitHub account's roles are read from", () => {
  const link = async (baseUrl: string, type: "github" | "gitlab", repo: number) => {
    const o = await org();
    const c = await createConnection(t.db, keys, {
      organizationId: o.id,
      type,
      name: `${type}-${repo}`,
      config: { baseUrl },
      token: "ghp_xxxxxxxx",
    });
    const { project } = await importProject(t.db, {
      organizationId: o.id,
      connectionId: c.id,
      gitlabProjectId: repo,
      name: `p${repo}`,
      defaultBranch: "main",
      types: [],
    });
    return { project, connection: c };
  };

  test("are those of github.com connections, and no other host's, no GitLab's and no unbound project's", async () => {
    const dot = await link("https://github.com", "github", 9001);
    const api = await link("https://api.github.com/", "github", 9002);
    const ghes = await link("https://ghe.example.com", "github", 9003);
    const gitlab = await link("https://github.com", "gitlab", 9004);
    const unbound = await createOrganization(t.db, { slug: `u${++n}`, name: "U" });
    await importProject(t.db, {
      organizationId: unbound.id,
      gitlabProjectId: 9005,
      name: "unbound",
      defaultBranch: "main",
      types: [],
    });
    const found = await githubLinks(t.db);
    const ids = found.map((l) => l.projectId);
    expect(ids).toContain(dot.project.id);
    expect(ids).toContain(api.project.id);
    expect(ids).not.toContain(ghes.project.id);
    expect(ids).not.toContain(gitlab.project.id);
    expect(found.find((l) => l.projectId === dot.project.id)).toEqual({
      projectId: dot.project.id,
      organizationId: dot.connection.organizationId,
      connectionId: dot.connection.id,
      repositoryId: 9001,
    });
    expect(found.some((l) => l.repositoryId === 9005)).toBe(false);
  });
});

// FRG-34: an organization linked to a GitHub organization, whose owners and members hold its roles.
describe("organizations linked to a GitHub organization", () => {
  test("are listed with their GitHub account id, in creation order, and the unlinked are not", async () => {
    const [a, b] = [7_100_000_001, 7_100_000_002];
    const first = await createOrganization(t.db, {
      slug: `hub-a${++n}`,
      name: "A",
      githubOrgId: a,
    });
    await createOrganization(t.db, { slug: `plain${++n}`, name: "P" });
    const second = await createOrganization(t.db, {
      slug: `hub-b${++n}`,
      name: "B",
      githubOrgId: b,
    });
    const found = (await githubOrgLinks(t.db)).filter((l) => [a, b].includes(l.githubOrgId));
    expect(found).toEqual([
      { organizationId: first.id, githubOrgId: a },
      { organizationId: second.id, githubOrgId: b },
    ]);
  });

  test("one GitHub organization belongs to one organization here, and many may have none", async () => {
    const hub = 7_100_000_003;
    await createOrganization(t.db, { slug: `hub-c${++n}`, name: "C", githubOrgId: hub });
    const err = await createOrganization(t.db, {
      slug: `hub-d${++n}`,
      name: "D",
      githubOrgId: hub,
    }).catch((e) => e);
    expect(pgConstraint(err)).toBe("organizations_github_org_key");
    await createOrganization(t.db, { slug: `none${++n}`, name: "N1" });
    await createOrganization(t.db, { slug: `none${++n}`, name: "N2" });
  });
});
