import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ORG_ROLES } from "@orch/core";
import { aad, CryptoError, encrypt, envKeyProvider, generateDek, wrapDek } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import { upsertUser } from "./auth";
import { pgConstraint } from "./pg-error";
import { createOrganization, deleteOrganization } from "./repo";
import { userIdentities, users } from "./schema";
import {
  createSsoProvider,
  deleteSsoProvider,
  endSsoMembership,
  getSsoProvider,
  getSsoProviderById,
  getSsoProviderBySlug,
  linkSsoIdentity,
  listIdentities,
  listOwnIdentities,
  listSsoMembers,
  openSsoSecret,
  setSsoEnabled,
  setSsoMembership,
  signInSso,
  ssoRolesOf,
  unlinkIdentity,
  updateSsoProvider,
} from "./sso";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const SECRET = "idp-client-SECRET-0123456789";

let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const RULES = [
  { claim: "groups", value: "platform", role: "admin" },
  { claim: "groups", value: "everyone", role: "viewer" },
] as const;
const make = async (organizationId: string, over: Partial<{ clientSecret: string }> = {}) =>
  createSsoProvider(t.db, keys, {
    organizationId,
    issuer: "https://idp.example.com/realms/acme",
    clientId: "orch",
    clientSecret: over.clientSecret ?? SECRET,
    emailDomains: ["acme.example"],
    roleMap: [...RULES],
  });
const raw = async (id: string) =>
  (await t.db.execute(sql`SELECT * FROM sso_providers WHERE id = ${id}`))[0] as Record<
    string,
    unknown
  >;

describe("an organization's identity provider", () => {
  test("is made off, keeps its rules as a list, and shows no secret, key or ciphertext", async () => {
    const o = await org();
    const p = await make(o.id);
    expect(p).toMatchObject({
      organizationId: o.id,
      issuer: "https://idp.example.com/realms/acme",
      clientId: "orch",
      emailDomains: ["acme.example"],
      enabled: false,
    });
    expect(p.roleMap).toEqual([...RULES]);
    expect((await getSsoProvider(t.db, o.id))?.roleMap).toEqual([...RULES]);
    expect((await getSsoProviderById(t.db, p.id))?.id).toBe(p.id);
    for (const row of [p, await getSsoProvider(t.db, o.id)]) {
      expect(Object.keys(row ?? {})).not.toContain("secretEnc");
      expect(Object.keys(row ?? {})).not.toContain("dekWrapped");
      expect(Object.keys(row ?? {})).not.toContain("dekKeyId");
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });

  test("the client secret is sealed in the table and opens only with the master key", async () => {
    const o = await org();
    const p = await make(o.id);
    const row = await raw(p.id);
    expect(Buffer.from(row.secret_enc as Uint8Array).includes(Buffer.from(SECRET))).toBe(false);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(await openSsoSecret(t.db, keys, p.id)).toBe(SECRET);
    await expect(openSsoSecret(t.db, envKeyProvider(`k9:${key(9)}`), p.id)).rejects.toBeInstanceOf(
      CryptoError,
    );
  });

  test("a sealed secret moved to another provider does not open there", async () => {
    const [a, b] = [await make((await org()).id), await make((await org()).id)];
    await t.db.execute(sql`
      UPDATE sso_providers SET secret_enc = (SELECT secret_enc FROM sso_providers WHERE id = ${a.id})
      WHERE id = ${b.id}`);
    await expect(openSsoSecret(t.db, keys, b.id)).rejects.toBeInstanceOf(CryptoError);
    expect(await openSsoSecret(t.db, keys, a.id)).toBe(SECRET);
  });

  test("a secret sealed for the same organization under another id does not open either", async () => {
    const o = await org();
    const p = await make(o.id);
    const dek = generateDek();
    const wrap = await wrapDek(keys, dek, `sso-provider:${p.id}`);
    await t.db.execute(sql`
      UPDATE sso_providers SET secret_enc = ${encrypt(dek, "forged", aad("sso_provider", o.id, "other-id"))},
        dek_key_id = ${wrap.keyId}, dek_wrapped = ${wrap.wrapped} WHERE id = ${p.id}`);
    await expect(openSsoSecret(t.db, keys, p.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("an organization has one", async () => {
    const o = await org();
    await make(o.id);
    const error = await make(o.id).catch((e: unknown) => e);
    expect(pgConstraint(error)).toBe("sso_providers_org_key");
  });

  test("update changes what it is given; the secret stays unless a new one is given", async () => {
    const o = await org();
    const p = await make(o.id);
    const before = await raw(p.id);
    const same = await updateSsoProvider(t.db, keys, o.id, {
      clientId: "orch2",
      enabled: true,
      emailDomains: ["a.example", "b.example"],
      roleMap: [{ claim: "roles", value: "x", role: "member" }],
    });
    expect(same).toMatchObject({ clientId: "orch2", enabled: true });
    expect(same?.emailDomains).toEqual(["a.example", "b.example"]);
    expect(same?.roleMap).toEqual([{ claim: "roles", value: "x", role: "member" }]);
    expect(await openSsoSecret(t.db, keys, p.id)).toBe(SECRET);
    expect(Buffer.from((await raw(p.id)).secret_enc as Uint8Array)).toEqual(
      Buffer.from(before.secret_enc as Uint8Array),
    );

    await updateSsoProvider(t.db, keys, o.id, { clientSecret: "second-SECRET" });
    expect(await openSsoSecret(t.db, keys, p.id)).toBe("second-SECRET");
    expect(JSON.stringify(await raw(p.id))).not.toContain("second-SECRET");
  });

  test("update of another organization's provider finds nothing", async () => {
    const [a, b] = [await org(), await org()];
    await make(a.id);
    expect(await updateSsoProvider(t.db, keys, b.id, { clientId: "x" })).toBeUndefined();
    expect(await getSsoProvider(t.db, b.id)).toBeUndefined();
  });

  test("delete removes it, once; an organization that has one cannot be deleted", async () => {
    const o = await org();
    await make(o.id);
    await expect(deleteOrganization(t.db, o.id)).rejects.toThrow();
    expect(await deleteSsoProvider(t.db, o.id)).toBe(true);
    expect(await deleteSsoProvider(t.db, o.id)).toBe(false);
    expect(await getSsoProvider(t.db, o.id)).toBeUndefined();
    expect(await deleteOrganization(t.db, o.id)).toBe(true);
  });
});

describe("identities", () => {
  const gid = () => Math.floor(Math.random() * 1e9);

  test("a person who signs in with GitLab has a gitlab identity, once", async () => {
    const gitlabId = gid();
    const user = await upsertUser(t.db, { gitlabId, username: "ada", name: "Ada" });
    await upsertUser(t.db, { gitlabId, username: "ada", name: "Ada" });
    expect(await listIdentities(t.db, user.id)).toEqual([
      expect.objectContaining({
        provider: "gitlab",
        subject: String(gitlabId),
        ssoProviderId: null,
      }),
    ]);
  });

  test("the migration gives users that already exist a gitlab identity", async () => {
    const gitlabId = gid();
    const user = await upsertUser(t.db, { gitlabId, username: "old", name: "Old" });
    await t.db.delete(userIdentities).where(eq(userIdentities.userId, user.id));
    expect(await listIdentities(t.db, user.id)).toEqual([]);
    const file = readFileSync(new URL("../drizzle/0043_identities.sql", import.meta.url), "utf8");
    const backfill = file.split("--> statement-breakpoint").find((s) => s.includes("-- backfill"));
    expect(backfill).toBeDefined();
    await t.db.execute(sql.raw(backfill ?? ""));
    expect((await listIdentities(t.db, user.id)).map((i) => [i.provider, i.subject])).toEqual([
      ["gitlab", String(gitlabId)],
    ]);
    await t.db.execute(sql.raw(backfill ?? "")); // safe to run again
    expect(await listIdentities(t.db, user.id)).toHaveLength(1);
  });

  test("a person may have no GitLab id, and several such people may exist", async () => {
    const rows = await t.db
      .insert(users)
      .values([
        { username: "a", name: "A" },
        { username: "b", name: "B" },
      ])
      .returning();
    expect(rows.map((r) => r.gitlabId)).toEqual([null, null]);
  });

  test("one identity belongs to one person", async () => {
    const [a, b] = [
      await upsertUser(t.db, { gitlabId: gid(), username: "a", name: "A" }),
      await upsertUser(t.db, { gitlabId: gid(), username: "b", name: "B" }),
    ];
    const taken = (await listIdentities(t.db, a.id))[0];
    const error = await t.db
      .insert(userIdentities)
      .values({ userId: b.id, provider: "gitlab", subject: taken?.subject ?? "" })
      .catch((e: unknown) => e);
    expect(pgConstraint(error)).toBe("user_identities_provider_subject_key");
  });

  test("an sso identity names its provider, and only its own; a gitlab one names none", async () => {
    const p = await make((await org()).id);
    const other = await make((await org()).id);
    const user = await upsertUser(t.db, { gitlabId: gid(), username: "u", name: "U" });
    const add = (v: { provider: string; ssoProviderId?: string }) =>
      t.db
        .insert(userIdentities)
        .values({ userId: user.id, subject: `s${++n}`, ...v })
        .then(
          () => undefined,
          (e: unknown) => pgConstraint(e),
        );
    expect(await add({ provider: `sso:${p.id}`, ssoProviderId: p.id })).toBeUndefined();
    expect(await add({ provider: `sso:${p.id}`, ssoProviderId: other.id })).toBe(
      "user_identities_provider_check",
    );
    expect(await add({ provider: `sso:${p.id}` })).toBe("user_identities_provider_check");
    expect(await add({ provider: "gitlab", ssoProviderId: p.id })).toBe(
      "user_identities_provider_check",
    );
    expect(await add({ provider: "bitbucket" })).toBe("user_identities_provider_check");
  });

  test("deleting a provider removes its identities, not the person", async () => {
    const o = await org();
    const p = await make(o.id);
    const user = await upsertUser(t.db, { gitlabId: gid(), username: "u", name: "U" });
    await t.db
      .insert(userIdentities)
      .values({ userId: user.id, provider: `sso:${p.id}`, subject: "abc", ssoProviderId: p.id });
    expect(await listIdentities(t.db, user.id)).toHaveLength(2);
    await deleteSsoProvider(t.db, o.id);
    expect((await listIdentities(t.db, user.id)).map((i) => i.provider)).toEqual(["gitlab"]);
    expect(await t.db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });
});

describe("signing in through a provider", () => {
  const gid = () => Math.floor(Math.random() * 1e9);
  const who = (
    over: Partial<{ subject: string; email: string; username: string; name: string }> = {},
  ) => ({
    subject: "sub-1",
    email: "ada@acme.example",
    username: "ada",
    name: "Ada",
    ...over,
  });

  test("an org's provider is found by the organization's slug, and an unknown slug finds none", async () => {
    const o = await org();
    const p = await make(o.id);
    expect((await getSsoProviderBySlug(t.db, o.slug))?.id).toBe(p.id);
    expect(await getSsoProviderBySlug(t.db, "no-such-org")).toBeUndefined();
    const bare = await org();
    expect(await getSsoProviderBySlug(t.db, bare.slug)).toBeUndefined();
  });

  test("a first sign-in makes a person with no GitLab id and one identity; the next finds the same person", async () => {
    const p = await make((await org()).id);
    const first = await signInSso(t.db, p.id, who());
    expect(first).toMatchObject({ gitlabId: null, username: "ada", name: "Ada" });
    const ids = await listIdentities(t.db, first.id);
    expect(ids).toMatchObject([
      { provider: `sso:${p.id}`, subject: "sub-1", ssoProviderId: p.id, email: "ada@acme.example" },
    ]);
    const again = await signInSso(
      t.db,
      p.id,
      who({ username: "ada2", name: "Ada L", email: "new@acme.example" }),
    );
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ username: "ada2", name: "Ada L" });
    expect((await listIdentities(t.db, first.id))[0]?.email).toBe("new@acme.example");
    expect(await t.db.select().from(users).where(eq(users.id, first.id))).toHaveLength(1);
  });

  test("the same subject at two providers is two people, and an existing GitLab person is never matched by name or email", async () => {
    const a = await make((await org()).id);
    const b = await make((await org()).id);
    const gitlab = await upsertUser(t.db, { gitlabId: gid(), username: "ada", name: "Ada" });
    const one = await signInSso(t.db, a.id, who());
    const two = await signInSso(t.db, b.id, who());
    expect(new Set([one.id, two.id, gitlab.id]).size).toBe(3);
  });

  test("two first sign-ins at the same moment end up as one person", async () => {
    const p = await make((await org()).id);
    const people = await Promise.all(
      [1, 2, 3].map(() => t.db.transaction((tx) => signInSso(tx, p.id, who({ subject: "race" })))),
    );
    expect(new Set(people.map((u) => u.id)).size).toBe(1);
    expect(await listIdentities(t.db, people[0]?.id ?? "")).toHaveLength(1);
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE username = 'ada' AND gitlab_id IS NULL AND id = ${people[0]?.id ?? ""}`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  test("it is turned on and off without a key, and changes nothing else; none is nothing", async () => {
    const o = await org();
    const p = await make(o.id);
    expect(await setSsoEnabled(t.db, o.id, true)).toEqual({
      ...p,
      enabled: true,
      updatedAt: expect.any(Date),
    });
    expect((await getSsoProvider(t.db, o.id))?.enabled).toBe(true);
    expect((await setSsoEnabled(t.db, o.id, false))?.enabled).toBe(false);
    expect(await openSsoSecret(t.db, keys, p.id)).toBe(SECRET);
    expect(await setSsoEnabled(t.db, (await org()).id, true)).toBeUndefined();
  });

  test("an unknown provider is refused", async () => {
    await expect(
      t.db.transaction((tx) => signInSso(tx, Bun.randomUUIDv7(), who())),
    ).rejects.toThrow();
  });
});

describe("the role a sign-in gives, for as long as the session lasts", () => {
  const person = (p: { id: string }, subject = "sub-1") =>
    signInSso(t.db, p.id, { subject, email: "a@acme.example", username: "a", name: "A" });
  const enable = (organizationId: string, enabled = true) =>
    updateSsoProvider(t.db, keys, organizationId, { enabled });
  const expireNow = (userId: string) =>
    t.db.execute(
      sql`UPDATE sso_memberships SET expires_at = now() - interval '1 second' WHERE user_id = ${userId}`,
    );
  const HOUR = 3_600_000;

  test("a membership gives its role in the provider's organization, and only there", async () => {
    const o = await org();
    const p = await make(o.id);
    await enable(o.id);
    const ada = await person(p);
    const bob = await person(p, "sub-2");
    await setSsoMembership(t.db, ada.id, p.id, "member", HOUR);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [o.id]: "member" });
    expect(await ssoRolesOf(t.db, bob.id)).toEqual({});
  });

  test("the next sign-in replaces the role and the time, and leaves one row", async () => {
    const o = await org();
    const p = await make(o.id);
    await enable(o.id);
    const ada = await person(p);
    await setSsoMembership(t.db, ada.id, p.id, "admin", HOUR);
    await expireNow(ada.id);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({});
    await setSsoMembership(t.db, ada.id, p.id, "viewer", HOUR);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [o.id]: "viewer" });
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM sso_memberships WHERE user_id = ${ada.id}`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  test("an expired membership gives nothing", async () => {
    const o = await org();
    const p = await make(o.id);
    await enable(o.id);
    const ada = await person(p);
    await setSsoMembership(t.db, ada.id, p.id, "owner", HOUR);
    await expireNow(ada.id);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({});
  });

  test("a provider that is off gives nothing, and gives it back when it is turned on", async () => {
    const o = await org();
    const p = await make(o.id); // made off
    const ada = await person(p);
    await setSsoMembership(t.db, ada.id, p.id, "admin", HOUR);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({});
    await enable(o.id);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [o.id]: "admin" });
    await enable(o.id, false);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({});
  });

  test("ending one provider's membership leaves the person's others, and says who it was", async () => {
    const [a, b] = [await org(), await org()];
    const [pa, pb] = [await make(a.id), await make(b.id)];
    await enable(a.id);
    await enable(b.id);
    const ada = await person(pa);
    await t.db
      .insert(userIdentities)
      .values({ userId: ada.id, provider: `sso:${pb.id}`, subject: "sub-b", ssoProviderId: pb.id });
    await setSsoMembership(t.db, ada.id, pa.id, "admin", HOUR);
    await setSsoMembership(t.db, ada.id, pb.id, "member", HOUR);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [a.id]: "admin", [b.id]: "member" });
    expect(await endSsoMembership(t.db, pa.id, "sub-1")).toBe(ada.id);
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [b.id]: "member" });
    expect(await endSsoMembership(t.db, pa.id, "sub-1")).toBeUndefined(); // nothing left
    expect(await endSsoMembership(t.db, pa.id, "nobody")).toBeUndefined();
    expect(await ssoRolesOf(t.db, ada.id)).toEqual({ [b.id]: "member" });
  });

  test("a role the organization does not have is refused by the table", async () => {
    const p = await make((await org()).id);
    const ada = await person(p);
    const insert = (role: string) =>
      t.db
        .execute(
          sql`INSERT INTO sso_memberships (user_id, sso_provider_id, role, expires_at)
              VALUES (${ada.id}, ${p.id}, ${role}, now() + interval '1 hour')`,
        )
        .then(
          () => undefined,
          (e: unknown) => pgConstraint(e),
        );
    expect(await insert("superuser")).toBe("sso_memberships_role_check");
    for (const role of ORG_ROLES) {
      await t.db.execute(sql`DELETE FROM sso_memberships WHERE user_id = ${ada.id}`);
      expect([role, await insert(role)]).toEqual([role, undefined]);
    }
  });

  test("deleting the provider or the person takes the membership with it", async () => {
    const [a, b] = [await org(), await org()];
    const [pa, pb] = [await make(a.id), await make(b.id)];
    const [ada, bob] = [await person(pa), await person(pb)];
    await setSsoMembership(t.db, ada.id, pa.id, "member", HOUR);
    await setSsoMembership(t.db, bob.id, pb.id, "member", HOUR);
    await deleteSsoProvider(t.db, a.id);
    await t.db.delete(users).where(eq(users.id, bob.id));
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM sso_memberships WHERE user_id IN (${ada.id}, ${bob.id})`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("finding memberships by provider", () => {
  test("an index leads with the provider: the member list and a provider's removal do not read every row", async () => {
    const rows = await t.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'sso_memberships'`,
    );
    const defs = Array.from(rows, (r) => String(r.indexdef));
    expect(
      defs.some((d) => d.includes("(sso_provider_id")),
      defs.join("\n"),
    ).toBe(true);
  });
});

describe("who holds a role in an organization through its provider", () => {
  const join = async (
    providerId: string,
    subject: string,
    username: string,
    role: "member" | "admin",
  ) => {
    const who = await signInSso(t.db, providerId, {
      subject,
      email: `${username}@acme.example`,
      username,
      name: username.toUpperCase(),
    });
    await setSsoMembership(t.db, who.id, providerId, role, 3_600_000);
    return who;
  };

  test("the live memberships of that provider only, by username, with their role and when it ends", async () => {
    const [a, b] = [await org(), await org()];
    const [pa, pb] = [await make(a.id), await make(b.id)];
    await updateSsoProvider(t.db, keys, a.id, { enabled: true });
    const [cy, bea] = [
      await join(pa.id, "s1", "cy", "admin"),
      await join(pa.id, "s2", "bea", "member"),
    ];
    const gone = await join(pa.id, "s3", "dee", "member");
    await t.db.execute(
      sql`UPDATE sso_memberships SET expires_at = now() - interval '1 second' WHERE user_id = ${gone.id}`,
    );
    await join(pb.id, "s4", "eve", "admin"); // another organization's
    const rows = await listSsoMembers(t.db, a.id, { limit: 10 });
    expect(rows.map((r) => [r.userId, r.username, r.name, r.role])).toEqual([
      [bea.id, "bea", "BEA", "member"],
      [cy.id, "cy", "CY", "admin"],
    ]);
    expect(rows.every((r) => r.expiresAt.getTime() > Date.now())).toBe(true);
    expect(await listSsoMembers(t.db, (await org()).id, { limit: 10 })).toEqual([]);
  });

  test("a provider that is off lists nobody, as it gives nobody a role", async () => {
    const o = await org();
    const p = await make(o.id);
    await join(p.id, "s1", "cy", "admin");
    expect(await listSsoMembers(t.db, o.id, { limit: 10 })).toEqual([]);
    await updateSsoProvider(t.db, keys, o.id, { enabled: true });
    expect(await listSsoMembers(t.db, o.id, { limit: 10 })).toHaveLength(1);
  });

  test("pages by username: after the last one seen, and no more than the limit", async () => {
    const o = await org();
    const p = await make(o.id);
    await updateSsoProvider(t.db, keys, o.id, { enabled: true });
    for (const name of ["d", "b", "a", "c"]) await join(p.id, `s-${name}`, name, "member");
    const first = await listSsoMembers(t.db, o.id, { limit: 3 });
    expect(first.map((r) => r.username)).toEqual(["a", "b", "c"]);
    const last = first.at(-1);
    const next = await listSsoMembers(t.db, o.id, {
      limit: 3,
      after: [last?.username ?? "", last?.userId ?? ""],
    });
    expect(next.map((r) => r.username)).toEqual(["d"]);
  });
});

describe("linking an identity to a person who is already signed in", () => {
  const gid = () => Math.floor(Math.random() * 1e9);
  const who = (subject: string, email = "ada@acme.example") => ({ subject, email });
  const gitlabPerson = (name = "ada") =>
    upsertUser(t.db, { gitlabId: gid(), username: name, name });
  const provider = async () => make((await org()).id);

  test("it adds the identity to that person and to nobody else, with no new person", async () => {
    const p = await provider();
    const me = await gitlabPerson();
    const before = (await t.db.select().from(users)).length;
    expect(await linkSsoIdentity(t.db, me.id, p.id, who("sub-1"))).toBe("linked");
    expect((await t.db.select().from(users)).length).toBe(before);
    expect(await listIdentities(t.db, me.id)).toMatchObject([
      { provider: "gitlab" },
      { provider: `sso:${p.id}`, subject: "sub-1", ssoProviderId: p.id, email: "ada@acme.example" },
    ]);
  });

  test("an identity held by another person is not theirs to take, and nothing changes", async () => {
    const p = await provider();
    const holder = await signInSso(t.db, p.id, { ...who("sub-1"), username: "h", name: "H" });
    const me = await gitlabPerson();
    expect(await linkSsoIdentity(t.db, me.id, p.id, who("sub-1", "other@acme.example"))).toBe(
      "taken",
    );
    expect(await listIdentities(t.db, me.id)).toHaveLength(1);
    expect(await listIdentities(t.db, holder.id)).toMatchObject([
      { subject: "sub-1", email: "ada@acme.example" },
    ]);
  });

  test("one's own identity again is a no-op that refreshes what the provider said", async () => {
    const p = await provider();
    const me = await gitlabPerson();
    await linkSsoIdentity(t.db, me.id, p.id, who("sub-1"));
    expect(await linkSsoIdentity(t.db, me.id, p.id, who("sub-1", "new@acme.example"))).toBe(
      "already",
    );
    const ids = await listIdentities(t.db, me.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]?.email).toBe("new@acme.example");
  });

  test("a person with a GitLab identity keeps the username and name GitLab gave when they sign in through the provider", async () => {
    const p = await provider();
    const me = await gitlabPerson("ada");
    await linkSsoIdentity(t.db, me.id, p.id, who("sub-1"));
    const again = await signInSso(t.db, p.id, {
      ...who("sub-1", "new@acme.example"),
      username: "platform-admin",
      name: "The Platform Admin",
    });
    expect(again.id).toBe(me.id);
    expect(again).toMatchObject({ username: "ada", name: "ada" });
    expect((await listIdentities(t.db, me.id))[1]?.email).toBe("new@acme.example");
  });

  test("two links of the same identity at the same moment give it to one of them", async () => {
    const p = await provider();
    const [a, b] = [await gitlabPerson("a"), await gitlabPerson("b")];
    const results = await Promise.all(
      [a, b].map((u) => t.db.transaction((tx) => linkSsoIdentity(tx, u.id, p.id, who("race")))),
    );
    expect(results.toSorted()).toEqual(["linked", "taken"]);
  });
});

describe("a person's own identities, and giving one up", () => {
  const gid = () => Math.floor(Math.random() * 1e9);
  const gitlabPerson = () => upsertUser(t.db, { gitlabId: gid(), username: "g", name: "G" });
  const sso = async () => {
    const o = await org();
    const p = await make(o.id);
    await updateSsoProvider(t.db, keys, o.id, { enabled: true });
    return { o, p };
  };
  const idOf = async (userId: string, kind: "gitlab" | "sso", providerId?: string) =>
    (await listIdentities(t.db, userId)).find((i) =>
      kind === "gitlab" ? i.provider === "gitlab" : i.ssoProviderId === providerId,
    )?.id ?? "";

  test("they are listed with the organization an SSO one belongs to, and no subject", async () => {
    const { o, p } = await sso();
    const me = await gitlabPerson();
    await linkSsoIdentity(t.db, me.id, p.id, { subject: "sub-1", email: "a@acme.example" });
    const rows = await listOwnIdentities(t.db, me.id);
    expect(rows).toMatchObject([
      { kind: "gitlab", organizationSlug: null },
      { kind: "sso", organizationSlug: o.slug, organizationName: "O", email: "a@acme.example" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("sub-1");
    expect(await listOwnIdentities(t.db, (await gitlabPerson()).id)).toHaveLength(1);
  });

  test("an SSO identity is given up with the role it gave, and the person's others stay", async () => {
    const [a, b] = [await sso(), await sso()];
    const me = await gitlabPerson();
    for (const x of [a, b]) {
      await linkSsoIdentity(t.db, me.id, x.p.id, { subject: "s", email: "a@acme.example" });
      await setSsoMembership(t.db, me.id, x.p.id, "admin", 3_600_000);
    }
    const out = await unlinkIdentity(t.db, me.id, await idOf(me.id, "sso", a.p.id));
    expect(out).toEqual({ status: "unlinked", ssoProviderId: a.p.id, organizationId: a.o.id });
    expect(await ssoRolesOf(t.db, me.id)).toEqual({ [b.o.id]: "admin" });
    expect(await listIdentities(t.db, me.id)).toHaveLength(2);
  });

  test("the last way to sign in stays, and so does its role", async () => {
    const { o, p } = await sso();
    const lone = await signInSso(t.db, p.id, {
      subject: "s",
      email: "a@acme.example",
      username: "l",
      name: "L",
    });
    await setSsoMembership(t.db, lone.id, p.id, "member", 3_600_000);
    expect(await unlinkIdentity(t.db, lone.id, await idOf(lone.id, "sso", p.id))).toEqual({
      status: "last",
    });
    expect(await ssoRolesOf(t.db, lone.id)).toEqual({ [o.id]: "member" });
  });

  test("the GitLab identity is the account's own and is not given up", async () => {
    const { p } = await sso();
    const me = await gitlabPerson();
    await linkSsoIdentity(t.db, me.id, p.id, { subject: "s", email: "a@acme.example" });
    expect(await unlinkIdentity(t.db, me.id, await idOf(me.id, "gitlab"))).toEqual({
      status: "gitlab",
    });
  });

  test("another person's identity, or none, is not found, and nothing is taken", async () => {
    const { p } = await sso();
    const [me, other] = [await gitlabPerson(), await gitlabPerson()];
    await linkSsoIdentity(t.db, other.id, p.id, { subject: "s", email: "a@acme.example" });
    const theirs = await idOf(other.id, "sso", p.id);
    expect(await unlinkIdentity(t.db, me.id, theirs)).toEqual({ status: "not_found" });
    expect(await unlinkIdentity(t.db, me.id, crypto.randomUUID())).toEqual({ status: "not_found" });
    expect(await listIdentities(t.db, other.id)).toHaveLength(2);
  });

  test("a person's two identities given up at the same moment leave one", async () => {
    const [a, b] = [await sso(), await sso()];
    const me = await signInSso(t.db, a.p.id, {
      subject: "s",
      email: "a@acme.example",
      username: "r",
      name: "R",
    });
    await linkSsoIdentity(t.db, me.id, b.p.id, { subject: "s", email: "a@acme.example" });
    const ids = [await idOf(me.id, "sso", a.p.id), await idOf(me.id, "sso", b.p.id)];
    const results = await Promise.all(
      ids.map((id) => t.db.transaction((tx) => unlinkIdentity(tx, me.id, id))),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual(["last", "unlinked"]);
    expect(await listIdentities(t.db, me.id)).toHaveLength(1);
  });
});
