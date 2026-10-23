import type { Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import type { Forge } from "@orch/forge";
import type { Template } from "@orch/pipelines";
import type { GuardrailConfig } from "@orch/sync";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import type { Applied } from "../pipeline-apply";
import {
  FLEET_DEFAULT_BATCH,
  FLEET_MAX_BATCH,
  type FleetDeps,
  listFleet,
  upgradeFleet,
} from "../pipeline-fleet";
import { catalogOf, forgeOf, recordApplied } from "./pipeline";
import { type RouteDeps, readErrors, writeErrors } from "./shared";

const params = z.object({ orgId: z.uuid() });
const template = z.string().min(1).max(100);
const version = z.string().min(1).max(50);
const batch = z.number().int().min(1).max(FLEET_MAX_BATCH);

/** What a call is asked: the template (at its newest version unless one is named) and which projects. */
const request = z.strictObject({
  template,
  version: version.optional(),
  /** Projects handled by this call. */
  limit: batch.default(FLEET_DEFAULT_BATCH),
  /** The `next` of the call before: continue after this project. */
  after: z.uuid().optional(),
});

const mr = z.object({ iid: z.number().int(), url: z.string() });
const result = z.object({
  template: z.string(),
  /** The version the projects are moved to. */
  target: z.string(),
  items: z.array(
    z.object({
      projectId: z.uuid(),
      projectName: z.string(),
      from: z.string(),
      to: z.string(),
      /** `would_upgrade`/`no_change`: a dry run. `upgraded`: applied (the merge request carries the new version; it is not necessarily merged). `skipped`: pinned to a newer version. `blocked`: the new version cannot be rendered or linted with this project's settings. `failed`: GitLab or the platform; run again. */
      status: z.enum(["would_upgrade", "no_change", "upgraded", "skipped", "blocked", "failed"]),
      /** What the default branch holds now: a `hand-written` file is replaced by the merge request. */
      existing: z.enum(["none", "identical", "generated", "hand-written"]).nullable(),
      /** Lines the default branch's file would gain and lose (a dry run only; approximate). */
      changes: z.object({ added: z.number().int(), removed: z.number().int() }).nullable(),
      outcome: z.enum(["opened", "updated", "unchanged", "in_place"]).nullable(),
      mr: mr.nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  /** Where to continue; null when this was the last batch. */
  next: z.uuid().nullable(),
});
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;

/**
 * Moving the projects set up from a template to another version of it (PIPE-7), in batches of at
 * most 50, with a pause between projects. Each project is what `pipeline.apply` does for it alone
 * (one merge request on the branch `orch/pipeline`, never the default branch), so all of it takes an
 * organization admin (`pipeline.upgrade`). The dry run (`POST /plan`) reads and lints and writes nothing.
 */
export const pipelineFleetRoutes = ({
  db,
  principal,
  keys,
  logger,
  templates: given,
  guardrails,
}: RouteDeps & {
  keys?: KeyProvider;
  logger: Logger;
  templates?: readonly Template[];
  guardrails?: GuardrailConfig | undefined;
}) => {
  const templates = catalogOf(given);
  const deps = async (
    orgId: string,
    requestId: unknown,
    record: FleetDeps["record"],
  ): Promise<FleetDeps> => {
    // one client per connection for the whole call: the token is opened once, and a connection that cannot be opened fails each of its projects at once
    const clients = new Map<string, Promise<Forge>>();
    return {
      db,
      catalog: await templates(),
      forge: (connectionId) => {
        const open =
          clients.get(connectionId) ??
          forgeOf({ db, keys, logger }, orgId, connectionId, requestId);
        clients.set(connectionId, open);
        return open;
      },
      record,
      pause: (ms) => Bun.sleep(ms),
      logger,
      guardrails,
    };
  };

  return new Elysia({ prefix: "/organizations/:orgId/pipeline-upgrades" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) =>
        listFleet({ db, catalog: await templates() }, orgId, query),
      {
        params,
        query: z.object({
          template,
          version: version.optional(),
          limit: z.coerce.number().int().min(1).max(FLEET_MAX_BATCH).default(FLEET_DEFAULT_BATCH),
          after: z.uuid().optional(),
        }),
        response: {
          200: z.object({
            template: z.string(),
            target: z.string(),
            /** The projects set up from this template at another version, by project id. */
            projects: z.array(
              z.object({
                projectId: z.uuid(),
                projectName: z.string(),
                version: z.string(),
                mrIid: z.number().int().nullable(),
                mrUrl: z.string().nullable(),
              }),
            ),
            next: z.uuid().nullable(),
          }),
          ...readErrors,
        },
        guard: "pipeline.upgrade",
      },
    )
    .post(
      "/plan",
      async ({ params: { orgId }, body, set }) => {
        if (!keys) throw noKeys();
        const d = await deps(orgId, set.headers["x-request-id"], async () => {
          throw new Error("a dry run records nothing");
        });
        return upgradeFleet(d, orgId, body, "plan");
      },
      {
        params,
        body: request,
        parse: "json",
        response: { 200: result, ...writeErrors, ...sealed },
        noAudit:
          "read-only: renders and lints each project's pipeline, writes nothing to GitLab or the database (it does use the connections to read the repositories)",
        guard: "pipeline.upgrade",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        const record = (projectId: string, applied: Applied) =>
          db
            .transaction((tx) =>
              recordApplied(tx, audit, orgId, projectId, applied, { via: "upgrade" }),
            )
            .then(() => undefined);
        const d = await deps(orgId, set.headers["x-request-id"], record);
        const r = await upgradeFleet(d, orgId, body, "apply");
        // one row for the call, whatever it did, besides the `pipeline.apply` row of each project
        const count = (status: string) => r.items.filter((i) => i.status === status).length;
        await db.transaction((tx) =>
          audit(tx, {
            action: "pipeline.upgrade",
            resourceType: "organization",
            resourceId: orgId,
            organizationId: orgId,
            metadata: {
              template: r.template,
              target: r.target,
              limit: body.limit,
              after: body.after ?? null,
              next: r.next,
              upgraded: count("upgraded"),
              skipped: count("skipped"),
              blocked: count("blocked"),
              failed: count("failed"),
              failedProjectIds: r.items
                .filter((i) => i.status === "failed")
                .map((i) => i.projectId),
              blockedProjectIds: r.items
                .filter((i) => i.status === "blocked")
                .map((i) => i.projectId),
            },
          }),
        );
        return r;
      },
      {
        params,
        body: request,
        parse: "json",
        response: { 200: result, ...writeErrors, ...sealed },
        audit: ["pipeline.upgrade", "pipeline.apply"],
        guard: "pipeline.upgrade",
      },
    );
};
