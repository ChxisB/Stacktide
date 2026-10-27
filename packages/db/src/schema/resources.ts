import type { BlueprintCloud, BlueprintKind } from "@orch/core";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * A resource the platform proposed from a blueprint (ADR-0024): a network, service, database or bucket,
 * in one environment of a project. The row is the platform's record of what it asked for; the repository
 * holds the Terraform and the cloud holds the thing, so nothing here is a credential or a value a person
 * typed beyond the blueprint's closed fields (`inputs` is the blueprint after `BlueprintSchema`).
 * Whether it exists is never stored: it is read from the runs of `stack` (`resourceStates`).
 *
 * `(environment, kind, name)` is the resource and `stack` is its state key. They are the same thing
 * said twice, but a dash runs names together (`dev-eu` + `main`, `dev` + `eu-main`), so two resources
 * can make one stack name: the second unique key refuses it, and the first check says that `stack` is
 * what the three make. The checks repeat `BlueprintSchema` and `safeDir` for a writer other than the
 * route; the schema's own rules (a size, a region) are the route's.
 */
export const resources = pgTable(
  "resources",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    environment: text().notNull(),
    kind: text().$type<BlueprintKind>().notNull(),
    cloud: text().$type<BlueprintCloud>().notNull(),
    name: text().notNull(),
    inputs: jsonb().$type<Record<string, unknown>>().notNull(),
    stack: text().notNull(),
    // The stack's directory in the repository, as the renderer wrote it.
    path: text().notNull(),
    // The merge or pull request that carries the files; null until the forge has answered.
    proposalUrl: text(),
    // The public links of the stack's state, as its newest plan summary carried them (BLP-17): where the resource
    // is served and where its cloud console shows it. Null until a plan has seen an applied stack.
    url: text(),
    consoleUrl: text(),
    // When the plan that reported them was asked for: a summary that arrives late is ignored (`recordResourceOutputs`).
    outputsAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique("resources_project_key").on(t.projectId, t.environment, t.kind, t.name),
    unique("resources_project_stack_key").on(t.projectId, t.stack),
    index("resources_project_idx").on(t.projectId, t.id),
    // CASCADE: a project's resources are its configuration and go with it (the cloud is untouched: deleting
    // is a plan, ADR-0024). The pair also makes the project one of the organization's.
    foreignKey({
      name: "resources_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check(
      "resources_check",
      sql`${t.kind} in ('network', 'service', 'postgres', 'bucket', 'deploy-identity')
        and ${t.cloud} in ('gcp', 'aws')
        and length(${t.environment}) <= 12 and ${t.environment} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and length(${t.name}) <= 12 and ${t.name} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and ${t.stack} = ${t.environment} || '-' || ${t.name} || '-' || ${t.kind}`,
    ),
    // `safeDir` of @orch/iac: segments of letters, digits and . _ @ + =, none starting with a dash, none . or ..
    check(
      "resources_path_check",
      sql`length(${t.path}) <= 255
        and ${t.path} ~ '^[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*(/[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*)*$'
        and ${t.path} !~ '(^|/)\\.{1,2}(/|$)'`,
    ),
    check(
      "resources_proposal_check",
      sql`${t.proposalUrl} is null or (length(${t.proposalUrl}) <= 2000 and ${t.proposalUrl} ~ '^https?://')`,
    ),
    // The links are public, printable and of http(s) (`OUTPUTS_FILTER`, and the plan-summary route again): they are shown as links.
    check(
      "resources_outputs_check",
      sql`(${t.url} is null or (length(${t.url}) <= 300 and ${t.url} ~ '^https?://[!-~]+$'))
        and (${t.consoleUrl} is null or (length(${t.consoleUrl}) <= 300 and ${t.consoleUrl} ~ '^https?://[!-~]+$'))`,
    ),
    // Size only: the driver stores a jsonb object as a JSON string, so the shape is `BlueprintSchema`'s.
    check("resources_inputs_check", sql`length(${t.inputs}::text) <= 10000`),
  ],
);
