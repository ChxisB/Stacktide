import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * A secret that GitLab's secret detection reported in a project (SCAN-2). This says where a finding is
 * and nothing of what it is: no excerpt, no value, nothing derived from either (the report's own
 * `raw_source_code_extract` is never read). A finding is the project's, matched across scans by
 * GitLab's `fingerprint`. `ref` is the branch of the pipeline that last reported it, or the default
 * branch once it has been seen there: only default-branch findings are resolved by a later scan.
 * `dismissed_*` are set together, and only while `status` is `dismissed`.
 */
export const secretFindings = pgTable(
  "secret_findings",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    fingerprint: text().notNull(),
    rule: text().notNull(),
    path: text().notNull(),
    line: integer(),
    commit: text().notNull(),
    severity: text().notNull(),
    ref: text().notNull(),
    status: text().notNull().default("open"),
    dismissedReason: text(),
    // `<kind>:<id>` as audit names a person.
    dismissedBy: text(),
    dismissedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    // CASCADE: a finding is the project's own record and goes with it.
    foreignKey({
      name: "secret_findings_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("secret_findings_fingerprint_idx").on(t.projectId, t.fingerprint),
    index("secret_findings_project_idx").on(t.organizationId, t.projectId, t.id),
    check("secret_findings_status_check", sql`${t.status} in ('open', 'dismissed', 'resolved')`),
    check(
      "secret_findings_severity_check",
      sql`${t.severity} in ('info', 'unknown', 'low', 'medium', 'high', 'critical')`,
    ),
    check("secret_findings_fingerprint_check", sql`${t.fingerprint} ~ '^[A-Za-z0-9_.:-]{1,100}$'`),
    check("secret_findings_rule_check", sql`${t.rule} ~ '^[a-z][a-z0-9-]{0,99}$'`),
    check("secret_findings_commit_check", sql`${t.commit} ~* '^[0-9a-f]{7,64}$'`),
    check("secret_findings_path_check", sql`char_length(${t.path}) between 1 and 1024`),
    check("secret_findings_ref_check", sql`char_length(${t.ref}) between 1 and 255`),
    check("secret_findings_line_check", sql`${t.line} is null or ${t.line} >= 1`),
    check(
      "secret_findings_dismissed_by_check",
      sql`${t.dismissedBy} is null or ${t.dismissedBy} ~ '^[a-z]{1,16}:[A-Za-z0-9._:@=+-]{1,120}$'`,
    ),
    check(
      "secret_findings_reason_check",
      sql`${t.dismissedReason} is null or char_length(${t.dismissedReason}) between 1 and 1000`,
    ),
    check(
      "secret_findings_dismissal_check",
      sql`(${t.status} = 'dismissed') = (${t.dismissedReason} is not null and ${t.dismissedBy} is not null and ${t.dismissedAt} is not null) and (${t.status} = 'dismissed' or (${t.dismissedReason} is null and ${t.dismissedBy} is null and ${t.dismissedAt} is null))`,
    ),
  ],
);
