import { z } from "zod";
import { type Check, CloudError, type Fetch, failure, httpsOrigin, reasonOf, send } from "./http";

/** The connection type, as `connections.type` stores it. */
export const KUBERNETES = "kubernetes";

/** What the platform does with Secrets in the namespaces it was given. */
export const KUBE_VERBS = ["get", "list", "create", "update", "delete"] as const;

const namespace = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "must be a namespace name");

/**
 * What a connection of type `kubernetes` says in the open: the API server, and the namespaces the
 * platform may write to (an allowlist the adapter enforces, whatever the token could do). The server
 * is an https origin with no credentials; a private CA is the certificate that signs it.
 *
 * shortcut: no path on the server (a proxy such as Rancher's `/k8s/clusters/...` is not supported);
 * add it when a cluster is only reachable through one.
 */
export const kubernetesConfigSchema = z.strictObject({
  server: httpsOrigin,
  namespaces: z
    .array(namespace)
    .min(1)
    .max(20)
    .refine((all) => new Set(all).size === all.length, "must not repeat a namespace"),
  ca: z
    .string()
    .max(20_000)
    .regex(
      /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/,
      "must be a PEM certificate",
    )
    .optional(),
});
export type KubernetesConfig = z.infer<typeof kubernetesConfigSchema>;

/** The secret of the connection: a service-account token, one printable word, so it can travel in a header. */
export const kubernetesTokenSchema = z
  .string()
  .min(20)
  .max(8192)
  .regex(/^[!-~]+$/, "must be a service-account token");

const WHY = {
  unauthorized: "rejected the token: it is wrong, expired or revoked",
  forbidden: "refused the token: it may not even ask what it is allowed to do",
  not_found: "has no authorization API at this address: check the server address",
} as const;

/**
 * The connection test: for each namespace and each verb, asks the API server (SelfSubjectAccessReview,
 * which any authenticated identity may ask about itself) whether the token may do it to Secrets. Nothing
 * is read or written. A token that may do more than it was given namespaces for is not noticed here:
 * the namespace list is enforced by the adapter, and the cluster's RBAC is the real limit.
 */
export async function checkKubernetes(
  config: KubernetesConfig,
  token: string,
  d: { fetch: Fetch; timeoutMs?: number | undefined },
): Promise<Check> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = `${config.server}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`;
  const may = async (ns: string, verb: string) => {
    const body = JSON.stringify({
      apiVersion: "authorization.k8s.io/v1",
      kind: "SelfSubjectAccessReview",
      spec: { resourceAttributes: { namespace: ns, verb, resource: "secrets" } },
    });
    const r = await send(
      d.fetch,
      url,
      { method: "POST", headers, body, ...(config.ca ? { tls: { ca: config.ca } } : {}) },
      d.timeoutMs,
    );
    if (r.status !== 200 && r.status !== 201) throw new CloudError(reasonOf(r.status));
    try {
      return (JSON.parse(r.text) as { status?: { allowed?: unknown } }).status?.allowed === true;
    } catch {
      throw new CloudError("unexpected");
    }
  };
  try {
    const lacking: string[] = [];
    for (const ns of config.namespaces) {
      const allowed = await Promise.all(KUBE_VERBS.map((verb) => may(ns, verb)));
      const missing = KUBE_VERBS.filter((_, i) => !allowed[i]);
      if (missing.length > 0) lacking.push(`namespace ${ns}: ${missing.join(", ")}`);
    }
    if (lacking.length > 0) {
      return {
        ok: false,
        reason: "forbidden",
        message: `Kubernetes refused: the token may not use Secrets in ${lacking.join("; ")}.`,
      };
    }
    return {
      ok: true,
      summary: `Secrets can be read and written in: ${config.namespaces.join(", ")}`,
    };
  } catch (e) {
    if (e instanceof CloudError) return failure("Kubernetes", e.reason, WHY);
    throw e;
  }
}
