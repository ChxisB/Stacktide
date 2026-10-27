import { createHmac } from "node:crypto";
import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { openWebhookSecret, recordDelivery, setWebhookSecretHash, webhookTarget } from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { rateLimitPlugin } from "../rate-limit";
import { hashToken, randomToken, safeEqual } from "../tokens";
import { notFound, problemSchema, type RouteDeps, readCapped, writeErrors } from "./shared";

/** GitLab's `X-Gitlab-Event` -> the name jobs use. Any other event is acknowledged and dropped. */
const EVENTS = {
  "Push Hook": "push",
  "Merge Request Hook": "merge_request",
  "Pipeline Hook": "pipeline",
  "Job Hook": "job",
  "Note Hook": "note",
  "Deployment Hook": "deployment",
} as const;
type EventName = (typeof EVENTS)[keyof typeof EVENTS];
type PickList = ReadonlyArray<readonly [string, readonly string[]]>;

/**
 * What a job gets of an event: `[name, path in the body]`. A fixed list, so a body can never put
 * anything else in a job: pipeline hooks carry CI variables, notes carry free text. No note text,
 * no variables, no commit messages; a deployment hook carries the user and the commit's title, and
 * the job gets neither.
 */
const PICKS: Record<EventName, PickList> = {
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
    // set for a child pipeline: the pipeline that started it (IAC-7 reads the run's jobs from there)
    ["sourcePipelineId", ["source_pipeline", "pipeline_id"]],
    ["sourceProjectId", ["source_pipeline", "project", "id"]],
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
    ["action", ["object_attributes", "action"]],
    ["mrIid", ["merge_request", "iid"]],
  ],
  // the environment's name is GitLab's own, which is the platform's slug for it (ADR-0020)
  deployment: [
    ["deploymentId", ["deployment_id"]],
    ["status", ["status"]],
    ["environment", ["environment"]],
  ],
};

/**
 * GitHub's `X-GitHub-Event` -> what a job gets of it (FRG-21): `[name, path in the body]`, a fixed list as above, so no
 * title, comment, message or login can reach a job. Events keep GitHub's own names, which none of the consumers written
 * for GitLab's events matches. A workflow run is the platform's pipeline, so its id is `pipelineId`.
 */
const GITHUB_PICKS = {
  workflow_run: [
    ["action", ["action"]],
    ["pipelineId", ["workflow_run", "id"]],
    ["status", ["workflow_run", "status"]],
    ["conclusion", ["workflow_run", "conclusion"]],
    ["ref", ["workflow_run", "head_branch"]],
    ["sha", ["workflow_run", "head_sha"]],
    ["attempt", ["workflow_run", "run_attempt"]],
  ],
  // `waiting` is a job held for an environment's reviewers
  workflow_job: [
    ["action", ["action"]],
    ["jobId", ["workflow_job", "id"]],
    ["pipelineId", ["workflow_job", "run_id"]],
    ["status", ["workflow_job", "status"]],
    ["conclusion", ["workflow_job", "conclusion"]],
    ["name", ["workflow_job", "name"]],
    ["ref", ["workflow_job", "head_branch"]],
    ["sha", ["workflow_job", "head_sha"]],
  ],
  pull_request: [
    ["action", ["action"]],
    ["iid", ["number"]],
    ["state", ["pull_request", "state"]],
    ["sourceBranch", ["pull_request", "head", "ref"]],
    ["targetBranch", ["pull_request", "base", "ref"]],
    ["sha", ["pull_request", "head", "sha"]],
    // the repository the branch is in: a consumer refuses a pull request from a fork
    ["headRepositoryId", ["pull_request", "head", "repo", "id"]],
  ],
  // only comments on pull requests (see the receiver); the text is read from GitHub by whoever acts on it
  issue_comment: [
    ["action", ["action"]],
    ["noteId", ["comment", "id"]],
    ["mrIid", ["issue", "number"]],
  ],
  deployment_review: [
    ["action", ["action"]],
    ["environment", ["environment"]],
    ["pipelineId", ["workflow_run", "id"]],
  ],
  // CLD-10: the consumer reads the deployment from GitHub, so only its id and the two names a log line wants are kept
  deployment_status: [
    ["action", ["action"]],
    ["deploymentId", ["deployment", "id"]],
    ["status", ["deployment_status", "state"]],
    ["environment", ["deployment", "environment"]],
  ],
} as const satisfies Record<string, PickList>;
type GithubEvent = keyof typeof GITHUB_PICKS;

/** The cap on a body we read; GitLab's own payloads stay far below it. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_VALUE = 200; // job payloads allow 256 characters per string
const DELIVERY_ID = /^[\x21-\x7e]{1,128}$/;
const GITHUB_SIGNATURE = /^sha256=[0-9a-f]{64}$/;

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
export const webhookRoutes = ({
  db,
  principal,
  logger,
  keys,
}: RouteDeps & { logger: Logger; keys?: KeyProvider | undefined }) =>
  new Elysia()
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .post(
      "/organizations/:orgId/connections/:connectionId/webhook-secret",
      async ({ params: { orgId, connectionId }, audit, set }) => {
        const secret = `orchwh_${randomToken(32)}`;
        await db.transaction(async (tx) => {
          // GitHub signs with the secret itself, so a hash of one is of no use: it is given when the connection is made
          const target = await webhookTarget(tx, connectionId);
          if (target?.organizationId === orgId && target.type === "github") {
            throw new DomainError(
              "webhook_secret_set_at_creation",
              422,
              "A GitHub connection's webhook secret is set when the connection is made",
            );
          }
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
        limit: "webhook",
        noAudit:
          "the delivery row and the job it creates are the record; nothing here is a change by a user",
      },
    )
    .post(
      "/webhooks/github/:connectionId",
      async ({ params, request, set }) => {
        const requestId = set.headers["x-request-id"]; // set by the `http` plugin
        const refused = () => {
          logger.warn("webhook refused", { request_id: requestId });
          return new DomainError(
            "invalid_webhook_token",
            401,
            "The webhook signature is not valid",
          );
        };
        const target = z.uuid().safeParse(params.connectionId).success
          ? await webhookTarget(db, params.connectionId)
          : undefined;
        const given = request.headers.get("x-hub-signature-256") ?? "";
        // What cannot be verified is refused before the body is read: not GitHub's connection, no secret to sign with
        // (an empty one would sign anything), a signature that is not the form GitHub sends. All the same 401.
        const secret =
          target?.type === "github" && keys && GITHUB_SIGNATURE.test(given)
            ? await openWebhookSecret(db, keys, target.organizationId, params.connectionId)
            : undefined;
        if (!target || !secret) throw refused();

        // The signature covers the body, so the body is read first, up to the cap.
        // shortcut: it is checked as UTF-8 text, so a body that is not valid UTF-8 fails; GitHub sends JSON.
        const text = await readCapped(request, MAX_WEBHOOK_BYTES);
        if (text === undefined) {
          throw new DomainError("payload_too_large", 413, "The webhook body is too large");
        }
        const expected = `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;
        if (!safeEqual(given, expected)) throw refused();

        // Verified from here on: an event nobody asked for (GitHub's `ping` is one) is acknowledged.
        const header = request.headers.get("x-github-event") ?? "";
        if (!Object.hasOwn(GITHUB_PICKS, header)) return { status: "ignored" as const };
        const event = header as GithubEvent;

        // shortcut: the delivery id is not covered by the signature, so a captured delivery could be sent again under a
        // new one; harmless while jobs only read the present state from GitHub, a risk if one ever acts on the body.
        const deliveryId = request.headers.get("x-github-delivery");
        if (deliveryId === null || !DELIVERY_ID.test(deliveryId)) throw badBody();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw badBody();
        }
        const projectId = at(body, ["repository", "id"]);
        if (!Number.isSafeInteger(projectId) || (projectId as number) < 1) throw badBody();
        // a comment on an issue is not ours; one on a pull request carries `issue.pull_request`
        if (event === "issue_comment" && !isRecord(at(body, ["issue", "pull_request"]))) {
          return { status: "ignored" as const };
        }

        const payload: Record<string, unknown> = {
          connectionId: params.connectionId,
          organizationId: target.organizationId,
          event,
          deliveryId,
          projectId,
        };
        for (const [name, path] of GITHUB_PICKS[event]) payload[name] = scalar(at(body, path));
        const status = await recordDelivery(db, {
          connectionId: params.connectionId,
          deliveryId,
          event,
          payload,
        });
        logger.info("webhook received", { request_id: requestId, event, status });
        return { status };
      },
      {
        // The body stays unread until the connection is known to take it and the signature has the right form.
        parse: "none",
        params: z.object({ connectionId: z.string().max(100) }),
        response: { 200: receipt, 400: problemSchema, 401: problemSchema, 413: problemSchema },
        public:
          "GitHub calls it with an HMAC of the body under the connection's webhook secret, which the handler checks",
        limit: "webhook",
        noAudit:
          "the delivery row and the job it creates are the record; nothing here is a change by a user",
      },
    );
