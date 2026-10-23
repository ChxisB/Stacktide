import { sql } from "drizzle-orm";
import { check, customType, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * A credential for an outside system, owned by an organization. `type` says which system
 * (`gitlab` first; EXT adds more without a migration), `config` holds what is not secret (the
 * base URL). The secret is sealed with the connection's own data key (`secret_enc`), and that key
 * is stored wrapped by a master key (`dek_*`, see ADR-0007): a database read alone yields nothing.
 * Only `connections.ts` in this package reads the three secret columns.
 *
 * `webhook_secret_hash` is the SHA-256 of the secret GitLab sends with webhooks (shown once, never
 * stored); null means the connection takes no webhooks. GitHub signs the body with an HMAC of its
 * secret, so a GitHub connection keeps the secret itself, sealed with the same data key as the token
 * (`webhook_secret_enc`, bound to a different context); null means it takes no webhooks either.
 */
export const connections = pgTable(
  "connections",
  {
    id: id(),
    // RESTRICT: removing an organization never silently takes its credentials with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    type: text().notNull(),
    name: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    secretEnc: bytea().notNull(),
    dekKeyId: text().notNull(),
    dekWrapped: bytea().notNull(),
    webhookSecretHash: text(),
    webhookSecretEnc: bytea(),
    ...timestamps(),
  },
  (t) => [
    unique("connections_org_name_key").on(t.organizationId, t.name),
    // Target of the composite foreign keys that will keep child rows in the connection's organization.
    unique("connections_id_org_key").on(t.id, t.organizationId),
    check("connections_type_check", sql`${t.type} ~ '^[a-z][a-z0-9_]{0,31}$'`),
  ],
);
