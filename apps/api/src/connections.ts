import { DomainError, type Logger } from "@orch/core";
import { CryptoError, type KeyProvider } from "@orch/crypto";
import { type Connection, type Db, openConnection } from "@orch/db";
import { createGitlab, GitlabError, type GitlabErrorKind } from "@orch/gitlab";
import {
  AWS_ASSUME_ROLE,
  type AwsCreds,
  type AwsDeps,
  assumedSession,
  awsConfigSchema,
  type Check,
  checkAwsAssumeRole,
  checkKubernetes,
  checkVaultAppRole,
  type Fetch,
  KUBERNETES,
  type KubernetesConfig,
  kubernetesConfigSchema,
  VAULT_APPROLE,
  vaultConfigSchema,
} from "@orch/sync";
import { z } from "zod";

/** What a connection test found. A failure is an answer, not an error: `message` is safe to show. */
export type ConnectionTest =
  | {
      ok: true;
      user: { gitlabId: number; username: string; name: string };
      /** What the token says it may do; `null` when GitLab would not say. */
      scopes: string[] | null;
      /** The token's expiry date (`2027-01-31`), `null` for none or unknown. */
      expiresAt: string | null;
    }
  | { ok: false; reason: GitlabErrorKind; message: string };

// Fixed texts: GitLab's own error text can name the URL or the path, and a user typed the URL.
export const WHY: Record<GitlabErrorKind, string> = {
  unauthorized: "GitLab rejected the token: it is wrong, expired or revoked.",
  forbidden:
    "GitLab refused the token: it needs the read_api scope (or api) and an active account.",
  not_found: "GitLab has no API at this URL: check the base URL.",
  conflict: "The URL answered, but not like GitLab: check the base URL.",
  invalid: "The URL answered, but not like GitLab: check the base URL.",
  unexpected: "The URL answered, but not like GitLab: check the base URL.",
  rate_limited: "GitLab is rate limiting requests: try again in a minute.",
  server: "GitLab failed with a server error: try again later.",
  timeout: "GitLab did not answer in time: check the base URL and the network.",
  network: "GitLab could not be reached: check the base URL and the network.",
};
const fail = (reason: GitlabErrorKind): ConnectionTest => ({
  ok: false,
  reason,
  message: WHY[reason],
});

/**
 * Asks GitLab who the token is (`/user`) and what it may do (`/personal_access_tokens/self`).
 * One retry and a short timeout: a person is waiting. The scopes are best effort, since an
 * older GitLab or another kind of token may not answer that call; the user is not.
 */
export async function testGitlab(input: {
  baseUrl: string;
  token: string;
}): Promise<ConnectionTest> {
  const api = createGitlab({
    baseUrl: input.baseUrl,
    auth: { type: "private-token", token: input.token },
    timeoutMs: 10_000,
    maxRetries: 1,
    maxRetryDelayMs: 2_000, // a Retry-After of minutes must not hold the request
  });
  try {
    const me = await api.users.current();
    if (!me.active) return fail("forbidden");
    const info = await api.users.tokenInfo().catch(() => undefined);
    // Known scopes must allow reading the API; unknown ones (an older GitLab) are let through.
    if (info && !info.scopes.some((s) => s === "api" || s === "read_api")) return fail("forbidden");
    return {
      ok: true,
      user: { gitlabId: me.gitlabId, username: me.username, name: me.name },
      scopes: info?.scopes ?? null,
      expiresAt: info?.expiresAt ?? null,
    };
  } catch (error) {
    if (error instanceof GitlabError) return fail(error.kind);
    throw error;
  }
}

/** How the checks of the non-GitLab connections reach their systems. Tests pass a fake `fetch`. */
export interface CloudDeps {
  fetch?: Fetch | undefined;
  /**
   * The platform's own AWS identity, read when a connection is checked. It needs one permission, to
   * assume the roles connections name; `undefined` when the operator gave it none.
   */
  aws?: (() => AwsCreds | undefined) | undefined;
}

/** Fixed words for a platform that was started without the identity an `aws_assume_role` connection needs. */
export const awsUnavailable = () =>
  new DomainError(
    "aws_identity_unavailable",
    503,
    "The platform has no AWS identity (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) to assume roles with",
  );

/** A stored configuration the schema no longer accepts is the operator's to fix, not a 500. */
const storedConfig = <T>(schema: z.ZodType<T>, stored: unknown): T => {
  const parsed = schema.safeParse(stored);
  if (!parsed.success) {
    throw new DomainError(
      "connection_config",
      422,
      "The stored configuration of this connection is not valid",
    );
  }
  return parsed.data;
};

/** Checks a stored or about-to-be-stored connection of one of the non-GitLab types against its system. */
export async function checkCloud(
  connection: { type: string; config: Record<string, unknown> },
  secret: string,
  cloud: CloudDeps = {},
): Promise<Check> {
  const fetch = cloud.fetch ?? globalThis.fetch;
  const config = <T>(schema: z.ZodType<T>) => storedConfig(schema, connection.config);
  switch (connection.type) {
    case AWS_ASSUME_ROLE: {
      const base = cloud.aws?.();
      if (!base) throw awsUnavailable();
      return checkAwsAssumeRole(config(awsConfigSchema), secret, { fetch, base });
    }
    case KUBERNETES:
      return checkKubernetes(config(kubernetesConfigSchema), secret, { fetch });
    case VAULT_APPROLE:
      return checkVaultAppRole(config(vaultConfigSchema), secret, { fetch });
  }
  throw new DomainError("connection_type", 422, "This type of connection cannot be tested");
}

// shortcut: literal loopback hosts only; a DNS name that resolves there passes. Resolve and check
// the addresses together with the SSRF follow-up (GL-6 LOG).
export const isLoopback = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  host === "0.0.0.0" ||
  /^127\./.test(host);

export const noKeys = () =>
  new DomainError(
    "secrets_unavailable",
    503,
    "No master key is configured (ORCH_MASTER_KEYS): connections cannot store or use secrets",
  );

/**
 * A connection of the organization with its secret opened, for talking to the system it belongs to.
 * Unknown (or another organization's) is a 404; a secret that cannot be opened is an operator's
 * problem (the master key is gone or the row was altered), logged by code only.
 */
export async function openAnyConnection(
  deps: { db: Db; keys?: KeyProvider; logger: Logger },
  orgId: string,
  connectionId: string,
  requestId: unknown,
): Promise<{ connection: Connection; token: string }> {
  if (!deps.keys) throw noKeys();
  const opened = await openConnection(deps.db, deps.keys, orgId, connectionId).catch((e) => {
    if (!(e instanceof CryptoError)) throw e;
    deps.logger.error("connection secret cannot be opened", {
      request_id: requestId,
      connection: connectionId,
      code: e.code,
    });
    throw new DomainError(
      "secret_unreadable",
      500,
      "The stored secret cannot be opened: check ORCH_MASTER_KEYS",
    );
  });
  if (!opened) throw new DomainError("not_found", 404, "Connection not found");
  return opened;
}

/** A GitLab connection, opened. */
export async function openGitlabConnection(
  deps: { db: Db; keys?: KeyProvider; logger: Logger },
  orgId: string,
  connectionId: string,
  requestId: unknown,
): Promise<{ connection: Connection; baseUrl: string; token: string }> {
  const opened = await openAnyConnection(deps, orgId, connectionId, requestId);
  // The type is free-form: another kind's secret must not be sent to a GitLab URL.
  if (opened.connection.type !== "gitlab") {
    throw new DomainError("connection_type", 422, "This is not a GitLab connection");
  }
  const { baseUrl } = z.object({ baseUrl: z.string() }).parse(opened.connection.config);
  return { connection: opened.connection, baseUrl, token: opened.token };
}

/** A Kubernetes connection, opened: the server, the namespaces it allows, and the service-account token. */
export async function openKubernetesConnection(
  deps: { db: Db; keys?: KeyProvider; logger: Logger },
  orgId: string,
  connectionId: string,
  requestId: unknown,
): Promise<{ config: KubernetesConfig; token: string }> {
  const { connection, token } = await openAnyConnection(deps, orgId, connectionId, requestId);
  // The type is free-form: another kind's secret must not be sent to a cluster.
  if (connection.type !== KUBERNETES) {
    throw new DomainError("connection_type", 422, "This is not a Kubernetes connection");
  }
  return { config: storedConfig(kubernetesConfigSchema, connection.config), token };
}

/**
 * How to reach AWS as the role of an `aws_assume_role` connection: the credentials come from the
 * platform's own identity assuming the role (with the connection's external ID), asked for when first
 * needed and again before they lapse. Nothing is assumed here; the secret stays in the closure.
 */
export async function openAwsSession(
  deps: { db: Db; keys?: KeyProvider; logger: Logger; cloud?: CloudDeps | undefined },
  orgId: string,
  connectionId: string,
  requestId: unknown,
): Promise<{ aws: AwsDeps; session: () => Promise<AwsCreds> }> {
  const { connection, token } = await openAnyConnection(deps, orgId, connectionId, requestId);
  // The type is free-form: another kind's secret must not be used as an external ID.
  if (connection.type !== AWS_ASSUME_ROLE) {
    throw new DomainError("connection_type", 422, "This is not an AWS connection");
  }
  const base = deps.cloud?.aws?.();
  if (!base) throw awsUnavailable();
  const role = storedConfig(awsConfigSchema, connection.config);
  const aws: AwsDeps = { fetch: deps.cloud?.fetch ?? globalThis.fetch };
  return { aws, session: assumedSession(aws, base, { ...role, externalId: token }) };
}
