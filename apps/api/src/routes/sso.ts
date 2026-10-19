import { DomainError, ORG_ROLES, type RoleRule, roleMap, roleRule } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  createSsoProvider,
  deleteSsoProvider,
  getSsoProvider,
  type SsoProvider,
  setSsoEnabled,
  updateSsoProvider,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { discover, fetchKeys, OidcError, publicTarget } from "../oidc";
import type { AuthDeps } from "./auth";
import {
  atLeastOne,
  deleteResponses,
  iso,
  mapDbError,
  nonEmpty,
  notFound,
  problemSchema,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";

const providerSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  issuer: z.string(),
  clientId: z.string(),
  emailDomains: z.array(z.string()),
  roleMap: z.array(roleRule),
  enabled: z.boolean(),
  ...stamps,
});
/** No secret, no data key, no ciphertext: `SsoProvider` has none of them to leave out. */
const dto = (p: SsoProvider): z.infer<typeof providerSchema> => ({
  id: p.id,
  organizationId: p.organizationId,
  issuer: p.issuer,
  clientId: p.clientId,
  emailDomains: p.emailDomains,
  roleMap: p.roleMap,
  enabled: p.enabled,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

const testSchema = z.union([
  z.object({ ok: z.literal(true), keys: z.number().int() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

const isIssuer = (v: string) => {
  try {
    const u = new URL(v);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
};
// What the provider calls itself, as it appears in the `iss` of its tokens: compared exactly, so it is stored as given. The lengths here are what an audit row can hold (a string of 256, 4 KB in all), so a valid body never fails to be recorded.
const issuer = z
  .string()
  .trim()
  .max(256)
  .refine(isIssuer, "must be the URL of the provider, without credentials, a query or a fragment");
const clientId = z.string().trim().min(1).max(255);
// Not trimmed: it is the provider's, to the character.
const clientSecret = z.string().min(1).max(1024);
const emailDomains = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(100)
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
        "a domain such as example.com, not an address or a wildcard",
      ),
  )
  .max(20);

const createBody = z.strictObject({ issuer, clientId, clientSecret, emailDomains, roleMap });
/** The issuer is not changed: identities are the issuer's `sub`s, and another issuer could hand out the same ones. */
const patchBody = z
  .strictObject({
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
    emailDomains: emailDomains.optional(),
    roleMap: roleMap.optional(),
  })
  .refine(nonEmpty, atLeastOne);

const params = z.object({ orgId: z.uuid() });
const unavailable = { ...writeErrors, 503: problemSchema } as const;
const once = (domains: string[]) => [...new Set(domains)];

/** Signing in needs a domain to accept and a rule to give a role: with neither, nobody could. */
const ready = (p: Pick<SsoProvider, "emailDomains" | "roleMap">) =>
  p.emailDomains.length > 0 && p.roleMap.length > 0;
const incomplete = () =>
  new DomainError(
    "sso_incomplete",
    422,
    "Single sign-on needs at least one email domain and one role rule while it is on",
  );

/**
 * What an audit row says of a role map: how many rules, and which roles they hand out. The rules name groups and
 * claim values, which an audit row does not hold; the map itself is read from the provider.
 */
const grants = (rules: readonly RoleRule[]) => ({
  roleRules: rules.length,
  roles: ORG_ROLES.filter((r) => rules.some((x) => x.role === r)),
});

const audited = (
  action: string,
  p: Pick<SsoProvider, "id" | "organizationId">,
  metadata: Record<string, unknown>,
) => ({
  action,
  resourceType: "sso_provider",
  resourceId: p.id,
  organizationId: p.organizationId,
  metadata,
});

/**
 * An organization's identity provider (SSO-5, ADR-0016): one OIDC provider, made off, set up by an owner and
 * seen by admins. The client secret goes in sealed and is never read back: no answer, audit row or log line has it,
 * and a change says that it was changed, not to what. Turning it on needs a domain and a rule; turning it off always
 * works. The issuer's address is judged like a notification sink's when it is made and again whenever it is asked.
 */
export const ssoRoutes = ({
  db,
  principal,
  keys,
  auth = {},
}: RouteDeps & { keys?: KeyProvider; auth?: AuthDeps }) => {
  const oidc = auth.oidc ?? {};
  const refuseAddress = (raw: string) =>
    (oidc.check ?? publicTarget(oidc.resolve))(raw).catch((e) => {
      if (!(e instanceof OidcError)) throw e;
      throw new DomainError(
        "issuer_refused",
        422,
        "The issuer must be an https address on a public host",
      );
    });

  /** Asks for the provider's endpoints and keys, and says in fixed words what came of it. */
  async function probe(raw: string): Promise<z.infer<typeof testSchema>> {
    try {
      const found = await discover(oidc, raw);
      const set = await fetchKeys(oidc, found.jwksUri);
      return set.length > 0
        ? { ok: true, keys: set.length }
        : { ok: false, message: "key set has no RSA signing key" };
    } catch (e) {
      if (e instanceof OidcError) return { ok: false, message: e.message };
      throw e;
    }
  }

  return new Elysia({ prefix: "/organizations/:orgId/sso" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId } }) => {
        const found = await getSsoProvider(db, orgId);
        if (!found) throw notFound("Single sign-on");
        return dto(found);
      },
      { params, response: { 200: providerSchema, ...readErrors }, guard: "sso.read" },
    )
    .put(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        await refuseAddress(body.issuer);
        const domains = once(body.emailDomains);
        const made = await db
          .transaction(async (tx) => {
            const p = await createSsoProvider(tx, keys, {
              organizationId: orgId,
              issuer: body.issuer,
              clientId: body.clientId,
              clientSecret: body.clientSecret,
              emailDomains: domains,
              roleMap: body.roleMap,
            });
            await audit(
              tx,
              audited("sso.create", p, {
                issuer: p.issuer,
                clientId: p.clientId,
                emailDomains: p.emailDomains,
                ...grants(p.roleMap),
              }),
            );
            return p;
          })
          .catch(
            mapDbError({
              sso_providers_org_key: new DomainError(
                "sso_exists",
                409,
                "This organization already has an identity provider: change it, or delete it first",
              ),
              sso_providers_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = 201;
        return dto(made);
      },
      {
        params,
        body: createBody,
        parse: "json",
        response: { 201: providerSchema, ...unavailable },
        audit: "sso.create",
        guard: "sso.manage",
      },
    )
    .patch(
      "",
      async ({ params: { orgId }, body, audit }) => {
        if (!keys) throw noKeys();
        const { clientSecret: secret, ...shown } = body;
        const patch = {
          ...shown,
          ...(body.emailDomains && { emailDomains: once(body.emailDomains) }),
        };
        const changed = await db.transaction(async (tx) => {
          const found = await getSsoProvider(tx, orgId);
          if (!found) throw notFound("Single sign-on");
          if (found.enabled && !ready({ ...found, ...patch })) throw incomplete();
          const p = await updateSsoProvider(tx, keys, orgId, {
            ...patch,
            ...(secret !== undefined && { clientSecret: secret }),
          });
          if (!p) throw notFound("Single sign-on");
          // what was changed, and that a secret was, never what it was
          await audit(
            tx,
            audited("sso.update", p, {
              fields: Object.keys(body).sort(),
              ...(patch.clientId !== undefined && { clientId: patch.clientId }),
              ...(patch.emailDomains && { emailDomains: patch.emailDomains }),
              ...(patch.roleMap && grants(patch.roleMap)),
            }),
          );
          return p;
        });
        return dto(changed);
      },
      {
        params,
        body: patchBody,
        parse: "json",
        response: { 200: providerSchema, ...unavailable },
        audit: "sso.update",
        guard: "sso.manage",
      },
    )
    .post(
      "/enable",
      async ({ params: { orgId }, audit }) =>
        dto(
          await db.transaction(async (tx) => {
            const found = await getSsoProvider(tx, orgId);
            if (!found) throw notFound("Single sign-on");
            if (!ready(found)) throw incomplete();
            const p = await setSsoEnabled(tx, orgId, true);
            if (!p) throw notFound("Single sign-on");
            await audit(tx, audited("sso.enable", p, { issuer: p.issuer }));
            return p;
          }),
        ),
      {
        params,
        response: { 200: providerSchema, ...writeErrors },
        audit: "sso.enable",
        guard: "sso.manage",
      },
    )
    .post(
      "/disable",
      async ({ params: { orgId }, audit }) =>
        dto(
          await db.transaction(async (tx) => {
            const p = await setSsoEnabled(tx, orgId, false);
            if (!p) throw notFound("Single sign-on");
            await audit(tx, audited("sso.disable", p, { issuer: p.issuer }));
            return p;
          }),
        ),
      {
        params,
        response: { 200: providerSchema, ...writeErrors },
        audit: "sso.disable",
        guard: "sso.manage",
      },
    )
    .post(
      "/test",
      async ({ params: { orgId }, audit }) => {
        const found = await getSsoProvider(db, orgId);
        if (!found) throw notFound("Single sign-on");
        const result = await probe(found.issuer);
        await db.transaction((tx) =>
          audit(
            tx,
            audited(
              "sso.test",
              found,
              result.ok ? { ok: true } : { ok: false, reason: result.message },
            ),
          ),
        );
        return result;
      },
      {
        params,
        response: { 200: testSchema, ...writeErrors },
        audit: "sso.test",
        guard: "sso.manage",
      },
    )
    .delete(
      "",
      async ({ params: { orgId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const found = await getSsoProvider(tx, orgId);
          if (!found || !(await deleteSsoProvider(tx, orgId))) throw notFound("Single sign-on");
          // its identities and memberships go with it
          await audit(tx, audited("sso.delete", found, { issuer: found.issuer }));
        });
        set.status = 204;
      },
      { params, response: deleteResponses, audit: "sso.delete", guard: "sso.manage" },
    );
};
