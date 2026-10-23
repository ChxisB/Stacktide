import type { OrgRole } from "@orch/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * An organization's OIDC identity provider (SSO-2, ADR-0016): who to trust, and the client secret to trust it
 * with. The secret is sealed like a connection's (own data key, wrapped by a master key, ADR-0007): a database
 * read alone yields nothing, and only `sso.ts` in this package reads the three secret columns. `role_map` is a
 * JSON list of rules (core's `roleMap`), kept as text so the driver cannot turn it into a JSON string. A provider
 * is made off and signs nobody in until it is enabled.
 */
export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: id(),
    // RESTRICT, like connections: removing an organization never silently takes its credentials with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    issuer: text().notNull(),
    clientId: text().notNull(),
    secretEnc: bytea().notNull(),
    dekKeyId: text().notNull(),
    dekWrapped: bytea().notNull(),
    emailDomains: text().array().notNull(),
    roleMap: text().notNull().default("[]"),
    enabled: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [unique("sso_providers_org_key").on(t.organizationId)],
);

/**
 * One way a person signs in (ADR-0016). `provider` is `gitlab` (subject: the GitLab user id), `github` (subject:
 * the GitHub user id, FRG-25) or `sso:<provider id>` (subject: the issuer's `sub`), so the same subject at two
 * issuers is two identities. The
 * pair is unique: an identity belongs to one person. Deleting a provider takes its identities, not the person.
 * `email` is what the provider last said, for showing only: nothing is ever matched on it.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    subject: text().notNull(),
    ssoProviderId: uuid().references(() => ssoProviders.id, { onDelete: "cascade" }),
    email: text(),
    ...timestamps(),
  },
  (t) => [
    unique("user_identities_provider_subject_key").on(t.provider, t.subject),
    index("user_identities_user_idx").on(t.userId),
    // `gitlab` and `github` name no provider row; `sso:<id>` names exactly its own (a null id must not slip through a null check).
    check(
      "user_identities_provider_check",
      sql`(${t.provider} in ('gitlab', 'github') and ${t.ssoProviderId} is null)
        or (${t.ssoProviderId} is not null and ${t.provider} = 'sso:' || ${t.ssoProviderId}::text)`,
    ),
  ],
);

/**
 * The role a person holds in an organization because of one sign-in through its provider (SSO-4, ADR-0016). Each
 * sign-in replaces the row with what the provider's role map says that time, and it ends when the session does, so
 * a person removed from a group at the provider loses the role at their next sign-in or within a session's life,
 * whichever comes first. No organization column: the provider says which one, and one provider belongs to one.
 */
export const ssoMemberships = pgTable(
  "sso_memberships",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ssoProviderId: uuid()
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    role: text().$type<OrgRole>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ssoProviderId] }),
    // the key starts with the person: a provider's member list and its removal ask by provider
    index("sso_memberships_provider_idx").on(t.ssoProviderId),
    // the roles of core's ORG_ROLES; a test gives the table each of them
    check("sso_memberships_role_check", sql`${t.role} in ('viewer', 'member', 'admin', 'owner')`),
  ],
);
