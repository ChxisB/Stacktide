import { type AuditContext, type AuditEvent, type Tx, audit as writeAudit } from "@orch/db";
import { Elysia, StatusMap } from "elysia";
import { type PrincipalResolver, principalPlugin } from "./principal";

/**
 * Audit for mutating routes. A route says what it records, in its options:
 *
 *   .post("/projects", handler, { audit: "project.create" })     // or an array of actions
 *   .post("/webhooks/x", handler, { noAudit: "why it is exempt" })
 *
 * and the handler calls `audit(tx, {...})` inside the transaction of the change itself. The
 * declaration is checked three ways:
 *  - an action the route did not declare (or any action on a `noAudit` route) throws inside the
 *    transaction, so the change rolls back with it;
 *  - a success that wrote no audit row is a 500, but only after the handler returned, so that
 *    change has committed: it is a tripwire for the route's own test, not a runtime guarantee;
 *  - `unauditedRoutes()` lists mutating routes with neither option; a test runs it over the app.
 * Both options show up as `x-audit` / `x-no-audit` in the OpenAPI doc.
 */
export const auditPlugin = (resolve: PrincipalResolver) =>
  new Elysia({ name: "orch.audit" })
    .use(principalPlugin(resolve))
    .resolve({ as: "scoped" }, ({ principal, request, server, set }) => {
      const state = { declared: [] as string[], written: 0 }; // the macro fills `declared`
      const requestId = set.headers["x-request-id"]; // set by the `http` plugin
      const ctx = {
        // Anonymous requests (sign-in) have no actor until the route names one.
        actor: principal && { kind: principal.kind, id: principal.id },
        requestId: requestId === undefined ? undefined : String(requestId),
        ip: server?.requestIP(request)?.address,
      };
      return {
        auditState: state,
        /**
         * Appends an event in `tx`. Its action must be one the route declared. `actor` names who
         * acted when that is not the request's principal (the sign-in route runs before there is one).
         */
        async audit(tx: Tx, event: AuditEvent, actor?: AuditContext["actor"]) {
          if (!state.declared.includes(event.action)) {
            throw new Error(`route did not declare audit action ${event.action}`);
          }
          const who = actor ?? ctx.actor;
          if (!who) throw new Error("audit has no actor: the request is anonymous");
          await writeAudit(tx, { ...ctx, actor: who }, event);
          state.written++;
        },
      };
    })
    .macro({
      audit: (actions: string | string[]) => {
        const declared = [actions].flat();
        return {
          detail: { "x-audit": declared } as object,
          beforeHandle({ auditState }) {
            if (auditState) auditState.declared = declared;
          },
          afterHandle({ auditState, response, set }) {
            // A returned `status(409)` or `Response` carries its own code; `set.status` is then unset.
            const r = response as { code?: unknown; status?: unknown } | null | undefined;
            const given = r?.code ?? r?.status ?? set.status;
            const code =
              typeof given === "string" ? StatusMap[given as keyof typeof StatusMap] : given;
            if (!auditState?.written && (typeof code !== "number" || code < 400)) {
              throw new Error(`route declared audit ${declared.join(", ")} but wrote none`);
            }
          },
        };
      },
      noAudit: (reason: string) => {
        if (!reason.trim()) throw new TypeError("noAudit needs a reason");
        return { detail: { "x-no-audit": reason } as object };
      },
    })
    .as("scoped");

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mutating routes (anything but GET/HEAD/OPTIONS) that neither declare `audit` nor `noAudit`. */
export function unauditedRoutes(app: {
  routes: ReadonlyArray<{ method: string; path: string; hooks?: unknown }>;
}) {
  return app.routes
    .filter((r) => !READ_ONLY.has(r.method.toUpperCase()))
    .filter((r) => {
      const detail = (r.hooks as { detail?: Record<string, unknown> } | undefined)?.detail;
      return !detail || (detail["x-audit"] === undefined && detail["x-no-audit"] === undefined);
    })
    .map((r) => `${r.method} ${r.path}`);
}
