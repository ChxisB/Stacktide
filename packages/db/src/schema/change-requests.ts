import type { ApplySubject } from "@orch/core";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { environments } from "./environments";
import { projects } from "./projects";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * A change that waits for a second person (GOV-2): the edits to the variables of one environment,
 * sealed (`ops_enc`, with the project's data key, bound to this request) until someone other than
 * the author approves and they are applied. `diff` is what anyone may see of it: key names and
 * actions, never a value. A trigger allows only the transitions of the state machine and nothing
 * on a closed request; a CHECK keeps the sealed edits to the states that still need them and the
 * decider apart from the author.
 */
export const changeRequests = pgTable(
  "change_requests",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    environmentId: uuid().notNull(),
    kind: text().notNull(),
    status: text().notNull().default("open"),
    diff: jsonb().notNull(),
    // What an approval to apply is for: the run it lets through (`subject_id`) and, in `subject`, its
    // target or the stacks at their plan jobs. Set for those kinds, never for variables.
    subjectId: uuid(),
    subject: jsonb().$type<Omit<ApplySubject, "runId">>(),
    // Null once the request is closed: a value nobody can apply is not kept.
    opsEnc: bytea(),
    // Who asked, as the audit trail names them, and as a person (`user:<id>` however they signed in).
    authorKind: text().notNull(),
    authorId: text().notNull(),
    authorRef: text().notNull(),
    decidedByKind: text(),
    decidedById: text(),
    decidedByRef: text(),
    decidedAt: timestamp({ withTimezone: true }),
    appliedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    // CASCADE: the request goes with its environment.
    foreignKey({
      name: "change_requests_environment_project_fk",
      columns: [t.environmentId, t.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "change_requests_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    index("change_requests_env_idx").on(t.environmentId, t.status, t.id),
    index("change_requests_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} in ('open', 'approved')`),
    check(
      "change_requests_kind_check",
      sql`${t.kind} in ('variables', 'sync_apply', 'iac_apply', 'deploy')`,
    ),
    check(
      "change_requests_status_check",
      sql`${t.status} in ('open', 'approved', 'applied', 'rejected', 'expired')`,
    ),
    // Edits are sealed while a request for variables is undecided; a request to apply seals nothing.
    check(
      "change_requests_ops_check",
      sql`case when ${t.kind} = 'variables' then (${t.status} in ('open', 'approved')) = (${t.opsEnc} is not null) else ${t.opsEnc} is null end`,
    ),
    // An approval to apply is for a run; a request for edits or to deploy has none.
    check(
      "change_requests_subject_check",
      sql`(${t.kind} in ('variables', 'deploy')) = (${t.subjectId} is null)`,
    ),
    index("change_requests_subject_idx")
      .on(t.projectId, t.subjectId)
      .where(sql`${t.subjectId} is not null`),
    // Four eyes, also in the database: whoever approved or applied is not whoever asked.
    check(
      "change_requests_four_eyes_check",
      sql`${t.status} not in ('approved', 'applied') or (${t.decidedByRef} is not null and ${t.decidedByRef} <> ${t.authorRef})`,
    ),
  ],
);
