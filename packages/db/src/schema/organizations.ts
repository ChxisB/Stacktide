import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    slug: text().notNull().unique("organizations_slug_key"),
    name: text().notNull(),
    // The GitLab group whose members are this organization's members (AUTH-5); fixed at creation.
    // shortcut: number mode loses precision above 2^53; GitLab ids are far below that.
    gitlabGroupId: bigint({ mode: "number" }),
    // Days the audit events of this organization are kept; null keeps them for ever (GOV-1). Only `audit_purge_expired()` reads it to delete.
    auditRetentionDays: integer(),
    // What open secret findings on a project's default branch do to its applies: off, warn or deny (SCAN-6).
    secretGate: text().notNull().default("off"),
    ...timestamps(),
  },
  (t) => [
    check(
      "organizations_audit_retention_check",
      sql`${t.auditRetentionDays} is null or ${t.auditRetentionDays} between 30 and 3650`,
    ),
    check("organizations_secret_gate_check", sql`${t.secretGate} in ('off', 'warn', 'deny')`),
    // One organization per group: a GitLab membership must not read as two organizations' roles.
    uniqueIndex("organizations_gitlab_group_key")
      .on(t.gitlabGroupId)
      .where(sql`${t.gitlabGroupId} IS NOT NULL`),
  ],
);
