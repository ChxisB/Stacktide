import { DomainError, type Logger } from "@orch/core";
import { recordDelivery, setWebhookSecretHash, webhookTarget } from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { hashToken, randomToken, safeEqual } from "../tokens";
import { notFound, problemSchema, type RouteDeps, readCapped, writeErrors } from "./shared";

/** GitLab's `X-Gitlab-Event` -> the name jobs use. Any other event is acknowledged and dropped. */
const EVENTS = {
  "Push Hook": "push",
  "Merge Request Hook": "merge_request",
  "Pipeline Hook": "pipeline",
  "Job Hook": "job",
  "Note Hook": "note",
} as const;
type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * What a job gets of an event: `[name, path in the body]`. A fixed list, so a body can never put
 * anything else in a job: pipeline hooks carry CI variables, notes carry free text. No note text,
 * no variables, no commit messages.
 */
const PICKS: Record<EventName, ReadonlyArray<readonly [string, readonly string[]]>> = {
  push: [
    ["ref", ["ref"]],
    ["before", ["before"]],
    ["after", ["after"]],
    ["commitCount", ["total_commits_count"]],
  ],
  merge_request: [
    ["iid", ["object_attributes", "iid"]],
    ["action", ["object_attributes", "action"]],
    ["state", ["object_attributes", "state"]],
    ["sourceBranch", ["object_attributes", "source_branch"]],
    ["targetBranch", ["object_attributes", "target_branch"]],
    ["sha", ["object_attributes", "last_commit", "id"]],
  ],
  pipeline: [
    ["pipelineId", ["object_attributes", "id"]],
    ["status", ["object_attributes", "status"]],
    ["ref", ["object_attributes", "ref"]],
    ["sha", ["object_attributes", "sha"]],
  ],
  job: [
    ["jobId", ["build_id"]],
    ["pipelineId", ["pipeline_id"]],
    ["status", ["build_status"]],
    ["name", ["build_name"]],
    ["ref", ["ref"]],
    ["sha", ["sha"]],
  ],
  note: [
    ["noteId", ["object_attributes", "id"]],
    ["noteableType", ["object_attributes", "noteable_type"]],
    ["mrIid", ["merge_request", "iid"]],
  ],
};

/** The cap on a body we read; GitLab's own payloads stay far below it. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_VALUE = 200; // job payloads allow 256 characters per string
const DELIVERY_ID = /^[\x21-\x7e]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const at = (body: unknown, path: readonly string[]) =>
  path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), body);
const scalar = (v: unknown) =>
  (typeof v === "string" && v.length <= MAX_VALUE) || (typeof v === "number" && Number.isFinite(v))
    ? v
    : undefined;

const badBody = () => new DomainError("invalid_webhook", 400, "The webhook body is not valid");

// Compared when the connection is unknown or has no secret, so those cost what a wrong token costs.
const NO_SECRET = hashToken(randomToken());

const receipt = z.object({ status: z.enum(["queued", "duplicate", "ignored"]) });
const issued = z.object({
  /** Shown once; GitLab sends it back as `X-Gitlab-Token`. */
  secret: z.string(),
  /** Where GitLab posts, relative to this API. */
  path: z.string(),
});

/**
 * GitLab webhooks (GL-8). Org admins issue a connection's webhook secret (shown once, only its
 * hash is stored; issuing again replaces it). The receiver is public and checks that secret
 * before it reads the body; an unknown connection, no secret set and a wrong token all answer the
 * same 401. A delivery becomes one job on `gitlab.event` (a repeat of a delivery id becomes none)
 * carrying ids and a few fields, never the body.
 */
export const webhookRoutes = ({ db, principal, logger }: RouteDeps & { logger: Logger }) =>
  new Elysia()
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .post(
      "/organizations/:orgId/connections/:connectionId/webhook-secret",
      async ({ params: { orgId, connectionId }, audit, set }) => {
        const secret = `orchwh_${randomToken(32)}`;
        await db.transaction(async (tx) => {
          if (!(await setWebhookSecretHash(tx, orgId, connectionId, hashToken(secret)))) {
            throw notFound("Connection");
          }
          await audit(tx, {
            action: "connection.webhook_secret",
            resourceType: "connection",
            resourceId: connectionId,
            organizationId: orgId,
          });
        });
        set.headers["cache-control"] = "no-store";
        return { secret, path: `/webhooks/gitlab/${connectionId}` };
      },
      {
        params: z.object({ orgId: z.uuid(), connectionId: z.uuid() }),
        response: { 200: issued, ...writeErrors },
        audit: "connection.webhook_secret",
        guard: "connection.webhook",
      },
    )
    .post(
      "/webhooks/gitlab/:connectionId",
      async ({ params, request, set }) => {
        const requestId = set.headers["x-request-id"]; // set by the `http` plugin
        const target = z.uuid().safeParse(params.connectionId).success
          ? await webhookTarget(db, params.connectionId)
          : undefined;
        const given = hashToken(request.headers.get("x-gitlab-token") ?? "");
        const same = safeEqual(given, target?.secretHash ?? NO_SECRET);
        if (!same || !target?.secretHash || target.type !== "gitlab") {
          logger.warn("webhook refused", { request_id: requestId });
          throw new DomainError("invalid_webhook_token", 401, "The webhook token is not valid");
        }

        const header = request.headers.get("x-gitlab-event") ?? "";
        const event = Object.hasOwn(EVENTS, header)
          ? EVENTS[header as keyof typeof EVENTS]
          : undefined;
        if (!event) return { status: "ignored" as const };

        const deliveryId =
          request.headers.get("idempotency-key") ?? request.headers.get("x-gitlab-event-uuid");
        if (deliveryId !== null && !DELIVERY_ID.test(deliveryId)) throw badBody();
        const text = await readCapped(request, MAX_WEBHOOK_BYTES);
        if (text === undefined) {
          throw new DomainError("payload_too_large", 413, "The webhook body is too large");
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw badBody();
        }
        const projectId = at(body, ["project", "id"]) ?? at(body, ["project_id"]);
        if (!Number.isSafeInteger(projectId) || (projectId as number) < 1) throw badBody();

        const payload: Record<string, unknown> = {
          connectionId: params.connectionId,
          organizationId: target.organizationId,
          event,
          deliveryId: deliveryId ?? undefined,
          projectId,
        };
        for (const [name, path] of PICKS[event]) payload[name] = scalar(at(body, path));
        const status = await recordDelivery(db, {
          connectionId: params.connectionId,
          deliveryId: deliveryId ?? undefined,
          event,
          payload,
        });
        logger.info("webhook received", { request_id: requestId, event, status });
        return { status };
      },
      {
        // The body stays unread until the token has been checked.
        parse: "none",
        params: z.object({ connectionId: z.string().max(100) }),
        response: { 200: receipt, 400: problemSchema, 401: problemSchema, 413: problemSchema },
        public: "GitLab calls it with the connection's webhook secret, which the handler checks",
        noAudit:
          "the delivery row and the job it creates are the record; nothing here is a change by a user",
      },
    );
