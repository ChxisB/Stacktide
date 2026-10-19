import { ORG_ROLES, type OrgRole, type RoleRule, roleMap } from "@orch/core";
import {
  aad,
  decrypt,
  encrypt,
  generateDek,
  type KeyProvider,
  unwrapDek,
  wrapDek,
} from "@orch/crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { User } from "./auth";
import type { Executor, Page } from "./repo";
import { organizations, ssoMemberships, ssoProviders, userIdentities, users } from "./schema";

type Row = typeof ssoProviders.$inferSelect;
/** What callers get to see of a provider: no secret, no data key, no ciphertext. */
export type SsoProvider = Omit<Row, "secretEnc" | "dekKeyId" | "dekWrapped" | "roleMap"> & {
  roleMap: RoleRule[];
};
export type Identity = typeof userIdentities.$inferSelect;

// What the secret and the data key are bound to: a ciphertext (or a wrapped key) moved to another row does not open.
const secretAad = (organizationId: string, id: string) => aad("sso_provider", organizationId, id);
const keyContext = (id: string) => `sso-provider:${id}`;

export { keyContext as ssoKeyContext }; // `rewrap.ts` needs the same context to move a key

const visible = {
  id: ssoProviders.id,
  organizationId: ssoProviders.organizationId,
  issuer: ssoProviders.issuer,
  clientId: ssoProviders.clientId,
  emailDomains: ssoProviders.emailDomains,
  roleMap: ssoProviders.roleMap,
  enabled: ssoProviders.enabled,
  createdAt: ssoProviders.createdAt,
  updatedAt: ssoProviders.updatedAt,
};
const provider = (row: Omit<Row, "secretEnc" | "dekKeyId" | "dekWrapped">): SsoProvider => ({
  ...row,
  roleMap: roleMap.parse(JSON.parse(row.roleMap)),
});

type Input = {
  issuer: string;
  clientId: string;
  emailDomains: string[];
  roleMap: readonly RoleRule[];
};

/** Makes the organization's provider, off. `clientSecret` is sealed with a data key made for it. */
export async function createSsoProvider(
  db: Executor,
  keys: KeyProvider,
  input: Input & { organizationId: string; clientSecret: string },
): Promise<SsoProvider> {
  const id = Bun.randomUUIDv7(); // the id is part of what the ciphertext is bound to
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(id));
  const [row] = await db
    .insert(ssoProviders)
    .values({
      id,
      organizationId: input.organizationId,
      issuer: input.issuer,
      clientId: input.clientId,
      emailDomains: input.emailDomains,
      roleMap: JSON.stringify(input.roleMap),
      secretEnc: encrypt(dek, input.clientSecret, secretAad(input.organizationId, id)),
      dekKeyId: wrap.keyId,
      dekWrapped: wrap.wrapped,
    })
    .returning(visible);
  if (!row) throw new Error("insert returned no row");
  return provider(row);
}

export async function getSsoProvider(db: Executor, organizationId: string) {
  const [row] = await db
    .select(visible)
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId));
  return row && provider(row);
}

/** The provider of the organization with this slug, or nothing (no such organization, or it has none). */
export async function getSsoProviderBySlug(db: Executor, slug: string) {
  const [row] = await db
    .select(visible)
    .from(ssoProviders)
    .innerJoin(organizations, eq(organizations.id, ssoProviders.organizationId))
    .where(eq(organizations.slug, slug));
  return row && provider(row);
}

export async function getSsoProviderById(db: Executor, id: string) {
  const [row] = await db.select(visible).from(ssoProviders).where(eq(ssoProviders.id, id));
  return row && provider(row);
}

/** Turns the organization's provider on or off, and changes nothing else (so it needs no key). Nothing if it has none. */
export async function setSsoEnabled(db: Executor, organizationId: string, enabled: boolean) {
  const [row] = await db
    .update(ssoProviders)
    .set({ enabled })
    .where(eq(ssoProviders.organizationId, organizationId))
    .returning(visible);
  return row && provider(row);
}

/** Changes the fields given. A new `clientSecret` is sealed again with a new data key; without one the sealed secret is untouched. */
export async function updateSsoProvider(
  db: Executor,
  keys: KeyProvider,
  organizationId: string,
  patch: Partial<Input> & { clientSecret?: string; enabled?: boolean },
): Promise<SsoProvider | undefined> {
  const { clientSecret, roleMap: rules, ...rest } = patch;
  const found = await getSsoProvider(db, organizationId);
  if (!found) return undefined;
  const sealed =
    clientSecret === undefined ? {} : await seal(keys, organizationId, found.id, clientSecret);
  const set = {
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    ...(rules && { roleMap: JSON.stringify(rules) }),
    ...sealed,
  };
  if (Object.keys(set).length === 0) return found;
  const [row] = await db
    .update(ssoProviders)
    .set(set)
    .where(eq(ssoProviders.id, found.id))
    .returning(visible);
  return row && provider(row);
}

async function seal(keys: KeyProvider, organizationId: string, id: string, secret: string) {
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(id));
  return {
    secretEnc: encrypt(dek, secret, secretAad(organizationId, id)),
    dekKeyId: wrap.keyId,
    dekWrapped: wrap.wrapped,
  };
}

/** True when a provider was deleted; its identities and memberships go with it. */
export async function deleteSsoProvider(db: Executor, organizationId: string) {
  const rows = await db
    .delete(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId))
    .returning({ id: ssoProviders.id });
  return rows.length > 0;
}

/**
 * The one way to get a provider's client secret back, for the code that exchanges a sign-in code with the
 * provider. The plaintext must go nowhere else: not a log, an error, an audit row or a response. Throws a
 * `CryptoError` when the master key is gone or the row was tampered with.
 */
export async function openSsoSecret(
  db: Executor,
  keys: KeyProvider,
  id: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      organizationId: ssoProviders.organizationId,
      secretEnc: ssoProviders.secretEnc,
      dekKeyId: ssoProviders.dekKeyId,
      dekWrapped: ssoProviders.dekWrapped,
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, id));
  if (!row) return undefined;
  const dek = await unwrapDek(
    keys,
    { keyId: row.dekKeyId, wrapped: row.dekWrapped },
    keyContext(id),
  );
  return decrypt(dek, row.secretEnc, secretAad(row.organizationId, id));
}

/** The ways a person signs in, oldest first. */
export function listIdentities(db: Executor, userId: string) {
  return db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.id));
}

/**
 * The person behind a provider's `sub`, made on a first sign-in (no GitLab id) and refreshed on later ones. The
 * match is the identity `(sso:<provider id>, sub)` and nothing else: never the email or the name, which a
 * provider can set to anything (ADR-0016). Run it in a transaction: a failure after the person is made must not
 * leave them behind.
 */
export async function signInSso(
  db: Executor,
  providerId: string,
  who: { subject: string; email: string; username: string; name: string },
): Promise<User> {
  const provider = `sso:${providerId}`;
  const [found] = await db
    .select({ identityId: userIdentities.id, userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, who.subject)));
  if (found) {
    await db
      .update(userIdentities)
      .set({ email: who.email })
      .where(eq(userIdentities.id, found.identityId));
    // A person who also signs in with GitLab keeps the username and name GitLab gave: a provider's word on who they are never replaces it.
    const [hasGitlab] = await db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, found.userId), eq(userIdentities.provider, "gitlab")));
    const [user] = await db
      .update(users)
      .set({
        ...(!hasGitlab && { username: who.username, name: who.name }),
        lastLoginAt: sql`now()`,
      })
      .where(eq(users.id, found.userId))
      .returning();
    if (!user) throw new Error("update returned no row");
    return user;
  }
  const [created] = await db
    .insert(users)
    .values({ username: who.username, name: who.name })
    .returning();
  if (!created) throw new Error("insert returned no row");
  const linked = await db
    .insert(userIdentities)
    .values({
      userId: created.id,
      provider,
      subject: who.subject,
      ssoProviderId: providerId,
      email: who.email,
    })
    .onConflictDoNothing()
    .returning({ id: userIdentities.id });
  if (linked.length > 0) return created;
  // A sign-in at the same moment made the person first: use theirs.
  await db.delete(users).where(eq(users.id, created.id));
  return signInSso(db, providerId, who);
}

export type LinkResult = "linked" | "already" | "taken";

/**
 * Ties a provider's `sub` to a person who is already signed in (SSO-7, ADR-0016): the one way an identity joins a
 * person who exists, and never by email. An identity another person holds is `taken` and left alone; the person's
 * own is `already` (what the provider said is refreshed). Run it in a transaction with the rest of the link.
 */
export async function linkSsoIdentity(
  db: Executor,
  userId: string,
  providerId: string,
  who: { subject: string; email: string },
): Promise<LinkResult> {
  const provider = `sso:${providerId}`;
  const [linked] = await db
    .insert(userIdentities)
    .values({ userId, provider, subject: who.subject, ssoProviderId: providerId, email: who.email })
    .onConflictDoNothing()
    .returning({ id: userIdentities.id });
  if (linked) return "linked";
  const [own] = await db
    .update(userIdentities)
    .set({ email: who.email })
    .where(
      and(
        eq(userIdentities.provider, provider),
        eq(userIdentities.subject, who.subject),
        eq(userIdentities.userId, userId),
      ),
    )
    .returning({ id: userIdentities.id });
  return own ? "already" : "taken";
}

/** A person's ways to sign in, oldest first, for showing: which organization an SSO one belongs to, never the `sub`. */
export function listOwnIdentities(db: Executor, userId: string) {
  return db
    .select({
      id: userIdentities.id,
      kind: sql<
        "gitlab" | "sso"
      >`case when ${userIdentities.ssoProviderId} is null then 'gitlab' else 'sso' end`,
      organizationSlug: organizations.slug,
      organizationName: organizations.name,
      email: userIdentities.email,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .leftJoin(ssoProviders, eq(ssoProviders.id, userIdentities.ssoProviderId))
    .leftJoin(organizations, eq(organizations.id, ssoProviders.organizationId))
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.id));
}

export type Unlinked =
  | { status: "unlinked"; ssoProviderId: string; organizationId: string }
  | { status: "not_found" }
  | { status: "gitlab" }
  | { status: "last" };

/**
 * A person gives up one of their SSO identities, and the role it gave goes with it. Not found: no such identity, or
 * it is another person's. Refused: the GitLab one (it is the account's own id) and the last way to sign in. Run it in
 * a transaction: the person's row is locked, so two given up at once cannot both see another one left.
 */
export async function unlinkIdentity(
  db: Executor,
  userId: string,
  identityId: string,
): Promise<Unlinked> {
  await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  const own = await db
    .select({
      id: userIdentities.id,
      ssoProviderId: userIdentities.ssoProviderId,
      organizationId: ssoProviders.organizationId,
    })
    .from(userIdentities)
    .leftJoin(ssoProviders, eq(ssoProviders.id, userIdentities.ssoProviderId))
    .where(eq(userIdentities.userId, userId));
  const mine = own.find((i) => i.id === identityId);
  if (!mine) return { status: "not_found" };
  if (!mine.ssoProviderId || !mine.organizationId) return { status: "gitlab" };
  if (own.length < 2) return { status: "last" };
  await db.delete(userIdentities).where(eq(userIdentities.id, mine.id));
  await db
    .delete(ssoMemberships)
    .where(
      and(eq(ssoMemberships.userId, userId), eq(ssoMemberships.ssoProviderId, mine.ssoProviderId)),
    );
  return {
    status: "unlinked",
    ssoProviderId: mine.ssoProviderId,
    organizationId: mine.organizationId,
  };
}

/**
 * The role a sign-in gave `userId` through a provider, until the session it started would end (`ttlMs`, the
 * session's own). The last sign-in's answer replaces the one before, so a changed role or a removed group shows at
 * once. The clock is the database's, like a session's.
 */
export async function setSsoMembership(
  db: Executor,
  userId: string,
  providerId: string,
  role: OrgRole,
  ttlMs: number,
) {
  const expiresAt = sql`now() + make_interval(secs => ${ttlMs / 1000})`;
  await db
    .insert(ssoMemberships)
    .values({ userId, ssoProviderId: providerId, role, expiresAt })
    .onConflictDoUpdate({
      target: [ssoMemberships.userId, ssoMemberships.ssoProviderId],
      set: { role, expiresAt },
    });
}

/**
 * Ends what an earlier sign-in gave the person behind `subject` at this provider, and says who they are (nothing
 * if they were unknown or held nothing). For a sign-in that no rule gives a role to.
 */
export async function endSsoMembership(db: Executor, providerId: string, subject: string) {
  const [ended] = await db
    .delete(ssoMemberships)
    .where(
      and(
        eq(ssoMemberships.ssoProviderId, providerId),
        inArray(
          ssoMemberships.userId,
          db
            .select({ id: userIdentities.userId })
            .from(userIdentities)
            .where(
              and(
                eq(userIdentities.provider, `sso:${providerId}`),
                eq(userIdentities.subject, subject),
              ),
            ),
        ),
      ),
    )
    .returning({ userId: ssoMemberships.userId });
  return ended?.userId;
}

/**
 * The organization roles `userId` holds through identity providers right now: memberships not yet expired, at
 * providers that are on. Asked at every request, so turning a provider off ends its roles at once.
 */
export async function ssoRolesOf(db: Executor, userId: string) {
  const rows = await db
    .select({ organizationId: ssoProviders.organizationId, role: ssoMemberships.role })
    .from(ssoMemberships)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoMemberships.ssoProviderId))
    .where(
      and(
        eq(ssoMemberships.userId, userId),
        eq(ssoProviders.enabled, true),
        sql`${ssoMemberships.expiresAt} > now()`,
      ),
    );
  const roles: Record<string, OrgRole> = {};
  for (const { organizationId, role } of rows) {
    const known = ORG_ROLES.find((r) => r === role); // a value the table's check would refuse is no role
    if (known) roles[organizationId] = known;
  }
  return roles;
}

/**
 * Who holds a role in the organization through its provider right now: the memberships `ssoRolesOf` would count
 * (provider on, not expired). Ordered by (username, id), so `after` (the last row's pair) pages without skipping.
 */
export function listSsoMembers(db: Executor, organizationId: string, page: Page<[string, string]>) {
  return db
    .select({
      userId: users.id,
      username: users.username,
      name: users.name,
      role: ssoMemberships.role,
      expiresAt: ssoMemberships.expiresAt,
    })
    .from(ssoMemberships)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoMemberships.ssoProviderId))
    .innerJoin(users, eq(users.id, ssoMemberships.userId))
    .where(
      and(
        eq(ssoProviders.organizationId, organizationId),
        eq(ssoProviders.enabled, true),
        sql`${ssoMemberships.expiresAt} > now()`,
        page.after
          ? sql`(${users.username}, ${users.id}) > (${page.after[0]}, ${page.after[1]})`
          : undefined,
      ),
    )
    .orderBy(asc(users.username), asc(users.id))
    .limit(page.limit);
}
