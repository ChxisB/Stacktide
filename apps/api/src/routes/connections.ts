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
import {
  AWS_ASSUME_ROLE,
  awsConfigSchema,
  type Check,
  externalIdSchema,
  KUBERNETES,
  kubernetesConfigSchema,
  kubernetesTokenSchema,
  VAULT_APPROLE,
  vaultConfigSchema,
  vaultSecretIdSchema,
} from "@orch/sync";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import {
  type CloudDeps,
  type ConnectionTest,
  checkCloud,
  isLoopback,
  noKeys,
  openAnyConnection,
  testGitlab,
} from "../connections";
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

// GitLab's answer names the user; the other systems' say in a sentence what was confirmed.
const testSchema = z.union([
  z.object({
    ok: z.literal(true),
    user: z.object({ gitlabId: z.number().int(), username: z.string(), name: z.string() }),
    scopes: z.array(z.string()).nullable(),
    expiresAt: z.string().nullable(),
  }),
  z.object({ ok: z.literal(true), summary: z.string() }),
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
  // The other systems: the shape of each is its module's, the secret is the one field that is sealed.
  z.strictObject({
    type: z.literal(AWS_ASSUME_ROLE),
    name,
    ...awsConfigSchema.shape,
    externalId: externalIdSchema,
  }),
  z.strictObject({
    type: z.literal(KUBERNETES),
    name,
    ...kubernetesConfigSchema.shape,
    token: kubernetesTokenSchema,
  }),
  z.strictObject({
    type: z.literal(VAULT_APPROLE),
    name,
    ...vaultConfigSchema.shape,
    secretId: vaultSecretIdSchema,
  }),
]);
type Create = z.infer<typeof create>;

/**
 * What is stored in the open and what is sealed, for a connection that is not GitLab's. The address is
 * refused when it points at this machine (unless the app allows that), then the system is asked; a
 * system that says no stops the create with its reason in fixed words.
 */
async function prepareCloud(
  body: Exclude<Create, { type: "gitlab" }>,
  o: { loopback: boolean; cloud: CloudDeps | undefined },
) {
  let config: Record<string, unknown>;
  let secret: string;
  let address: string | undefined;
  if (body.type === AWS_ASSUME_ROLE) {
    config = { roleArn: body.roleArn, region: body.region };
    secret = body.externalId;
  } else if (body.type === KUBERNETES) {
    config = {
      server: body.server,
      namespaces: body.namespaces,
      ...(body.ca === undefined ? {} : { ca: body.ca }),
    };
    secret = body.token;
    address = body.server;
  } else {
    config = {
      address: body.address,
      roleId: body.roleId,
      authMount: body.authMount,
      kvMount: body.kvMount,
      prefix: body.prefix,
    };
    secret = body.secretId;
    address = body.address;
  }
  if (!o.loopback && address && isLoopback(new URL(address).hostname)) {
    throw new DomainError("base_url_refused", 422, "The address must not point at this machine");
  }
  const found = await checkCloud({ type: body.type, config }, secret, o.cloud);
  if (!found.ok) throw new DomainError("connection_test_failed", 422, found.message);
  return { config, secret };
}

/** What a create body stores and seals, once its system has said the credential works. */
async function prepare(body: Create, o: { loopback: boolean; cloud: CloudDeps | undefined }) {
  if (body.type !== "gitlab") return prepareCloud(body, o);
  const config: Record<string, unknown> = { baseUrl: normalized(body.baseUrl) };
  if (!o.loopback && isLoopback(new URL(String(config.baseUrl)).hostname)) {
    throw new DomainError("base_url_refused", 422, "The base URL must not point at this machine");
  }
  const found = await testGitlab({ baseUrl: String(config.baseUrl), token: body.token });
  if (!found.ok) throw new DomainError("connection_test_failed", 422, found.message);
  return { config, secret: body.token };
}

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
  cloud,
}: RouteDeps & {
  keys?: KeyProvider;
  logger: Logger;
  loopbackConnections?: boolean;
  cloud?: CloudDeps;
}) =>
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
        const { config, secret } = await prepare(body, { loopback: loopbackConnections, cloud });
        // a CA certificate is long and public, and not what an audit reader looks for
        const { ca: _ca, ...shown } = config;
        const connection = await db
          .transaction(async (tx) => {
            const c = await createConnection(tx, keys, {
              organizationId: orgId,
              type: body.type,
              name: body.name,
              config,
              token: secret,
            });
            await audit(
              tx,
              audited("connection.create", c, { type: c.type, name: c.name, ...shown }),
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
      async ({ params: { orgId, connectionId }, audit, set }): Promise<ConnectionTest | Check> => {
        const { connection, token } = await openAnyConnection(
          { db, keys, logger },
          orgId,
          connectionId,
          set.headers["x-request-id"],
        );
        const result =
          connection.type === "gitlab"
            ? await testGitlab({ baseUrl: z.string().parse(connection.config.baseUrl), token })
            : await checkCloud(connection, token, cloud);
        await db.transaction((tx) =>
          audit(
            tx,
            audited("connection.test", connection, {
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
        await db
          .transaction(async (tx) => {
            const c = await getConnection(tx, orgId, connectionId);
            if (!c || !(await deleteConnection(tx, orgId, connectionId))) {
              throw notFound("Connection");
            }
            await audit(tx, audited("connection.delete", c, { type: c.type, name: c.name }));
          })
          .catch(
            mapDbError({
              // RESTRICT: a connection that sync targets use is not taken from under them.
              sync_targets_connection_org_fk: new DomainError(
                "connection_in_use",
                409,
                "Sync targets still use this connection",
              ),
            }),
          );
        set.status = 204;
      },
      {
        params: itemParams,
        response: deleteResponses,
        audit: "connection.delete",
        guard: "connection.delete",
      },
    );
