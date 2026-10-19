import { SECRET_GATES } from "@orch/core";
import { getSecretGate, setSecretGate } from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { notFound, type RouteDeps, readErrors, writeErrors } from "./shared";

const orgParams = z.object({ orgId: z.uuid() });
const gateSchema = z.object({ gate: z.enum(SECRET_GATES) });

/**
 * What an organization does about open secret findings on a project's default branch (SCAN-6): `off`
 * (the default) ignores them, `warn` names them in the merge request note, `deny` refuses the apply. It
 * is the organization's and not a stack's or a repository's, so a merge request cannot lower it. Anyone in
 * the organization reads it; org admins set it, as they do the cost limits.
 */
export const secretGateRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/secret-gate" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId } }) => {
        const gate = await getSecretGate(db, orgId);
        if (!gate) throw notFound("Organization");
        return { gate };
      },
      {
        params: orgParams,
        response: { 200: gateSchema, ...readErrors },
        guard: "secret.gate.read",
      },
    )
    .put(
      "",
      async ({ params: { orgId }, body, audit }) => {
        await db.transaction(async (tx) => {
          const was = await setSecretGate(tx, orgId, body.gate);
          if (!was) throw notFound("Organization");
          await audit(tx, {
            action: "secret.gate.update",
            resourceType: "organization",
            resourceId: orgId,
            organizationId: orgId,
            metadata: { gate: body.gate, previous: was.previous },
          });
        });
        return { gate: body.gate };
      },
      {
        params: orgParams,
        body: z.strictObject({ gate: z.enum(SECRET_GATES) }),
        parse: "json",
        response: { 200: gateSchema, ...writeErrors },
        audit: "secret.gate.update",
        guard: "secret.gate.update",
      },
    );
