import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type Connection,
  createConnection,
  deleteConnection,
  getConnection,
  getOrganization,
  listConnections,
} from "@orch/db";
import { parseBaseUrl } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { type ConnectionTest, noKeys, openGitlabConnection, testGitlab } from "../connections";
import { guardPlugin } from "../guard";
import {
  deleteResponses,
  iso,
  mapDbError,
  name,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readErrors,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const connectionSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  type: z.string(),
  name: z.string(),
  /** Everything about the connection that is not secret. */
  config: z.record(z.string(), z.unknown()),
  ...stamps,
});
const connectionDto = (c: Connection): z.infer<typeof connectionSchema> => ({
  id: c.id,
  organizationId: c.organizationId,
  type: c.type,
  name: c.name,
  config: c.config,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

const testSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    user: z.object({ gitlabId: z.number().int(), username: z.string(), name: z.string() }),
    scopes: z.array(z.string()).nullable(),
    expiresAt: z.string().nullable(),
  }),
  z.object({ ok: z.literal(false), reason: z.string(), message: z.string() }),
]);

const BASE_URL_HELP = "must be the https URL of a GitLab instance, without credentials";
const baseUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => {
    try {
      parseBaseUrl(v);
      return true;
    } catch {
      return false;
    }
  }, BASE_URL_HELP);
// shortcut: literal loopback hosts only; a DNS name that resolves there passes. Resolve and check
// the addresses together with the SSRF follow-up (GL-6 LOG).
const isLoopback = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  host === "0.0.0.0" ||
  /^127\./.test(host);
/** Origin and path only: a query, a fragment or a trailing slash is dropped. */
const normalized = (v: string) => {
  const u = parseBaseUrl(v);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
};

const create = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gitlab"),
    name,
    baseUrl,
    // A personal, project or group access token: printable ASCII, so it can travel in a header.
    token: z
      .string()
      .trim()
      .min(8)
      .max(512)
      .regex(/^[!-~]+$/, "must be a GitLab access token"),
  }),
]);

const params = z.object({ orgId: z.uuid() });
const itemParams = params.extend({ connectionId: z.uuid() });
const unavailable = { ...writeErrors, 503: problemSchema } as const;

const audited = (action: string, c: Connection, metadata: Record<string, unknown>) => ({
  action,
  resourceType: "connection",
  resourceId: c.id,
  organizationId: c.organizationId,
  metadata,
});

/**
 * Credentials for outside systems, per organization (GL-6). The token is sealed before it is
 * stored and comes back out only to talk to the system it belongs to: no route, log line or audit
 * row has it, and a failed test says why in fixed words. Create tests the token first, so a bad
 * one is never stored. Org admins only.
 */
export const connectionRoutes = ({
  db,
  principal,
  keys,
  logger,
  loopbackConnections = false,
}: RouteDeps & { keys?: KeyProvider; logger: Logger; loopbackConnections?: boolean }) =>
  new Elysia({ prefix: "/organizations/:orgId/connections" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (c) => [c.id],
          fetch: (after, limit) => listConnections(db, orgId, { after: after?.[0], limit }),
          dto: connectionDto,
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(connectionSchema), ...readErrors },
        guard: "connection.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        const config = { baseUrl: normalized(body.baseUrl) };
        if (!loopbackConnections && isLoopback(new URL(config.baseUrl).hostname)) {
          throw new DomainError(
            "base_url_refused",
            422,
            "The base URL must not point at this machine",
          );
        }
        const found = await testGitlab({ ...config, token: body.token });
        if (!found.ok) throw new DomainError("connection_test_failed", 422, found.message);
        const connection = await db
          .transaction(async (tx) => {
            const c = await createConnection(tx, keys, {
              organizationId: orgId,
              type: body.type,
              name: body.name,
              config,
              token: body.token,
            });
            await audit(
              tx,
              audited("connection.create", c, { type: c.type, name: c.name, ...config }),
            );
            return c;
          })
          .catch(
            mapDbError({
              connections_org_name_key: taken("name_taken", "The name"),
              connections_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = 201;
        return connectionDto(connection);
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: connectionSchema, ...unavailable },
        audit: "connection.create",
        guard: "connection.create",
      },
    )
    .post(
      "/:connectionId/test",
      async ({ params: { orgId, connectionId }, audit, set }): Promise<ConnectionTest> => {
        const opened = await openGitlabConnection(
          { db, keys, logger },
          orgId,
          connectionId,
          set.headers["x-request-id"],
        );
        const result = await testGitlab({ baseUrl: opened.baseUrl, token: opened.token });
        await db.transaction((tx) =>
          audit(
            tx,
            audited("connection.test", opened.connection, {
              ok: result.ok,
              ...(result.ok ? {} : { reason: result.reason }),
            }),
          ),
        );
        return result;
      },
      {
        params: itemParams,
        response: { 200: testSchema, ...unavailable },
        audit: "connection.test",
        guard: "connection.test",
      },
    )
    .delete(
      "/:connectionId",
      async ({ params: { orgId, connectionId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const c = await getConnection(tx, orgId, connectionId);
          if (!c || !(await deleteConnection(tx, orgId, connectionId))) {
            throw notFound("Connection");
          }
          await audit(tx, audited("connection.delete", c, { type: c.type, name: c.name }));
        });
        set.status = 204;
      },
      {
        params: itemParams,
        response: deleteResponses,
        audit: "connection.delete",
        guard: "connection.delete",
      },
    );
