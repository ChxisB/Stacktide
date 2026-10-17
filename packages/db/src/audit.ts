import type { Executor } from "./repo";
import { auditEvents } from "./schema";

/** A transaction: the audit row must commit or roll back together with the change it records. */
export type Tx = Parameters<Parameters<Executor["transaction"]>[0]>[0];

export interface AuditContext {
  actor: { kind: string; id: string };
  requestId?: string;
  ip?: string;
}

export interface AuditEvent {
  /** Dotted, lower case: `project.create`, `variable.reveal`. */
  action: string;
  resourceType: string;
  resourceId?: string;
  organizationId?: string;
  projectId?: string;
  /** Ids, key names, counts and flags. Never a value: see `checkMetadata`. */
  metadata?: Record<string, unknown>;
}

/** A refused audit write. The message names the offending key, never a value. */
export class AuditError extends Error {
  override readonly name = "AuditError";
}

// A key with one of these words holds, or is likely to hold, something secret.
const SECRET_WORDS = new Set([
  "value",
  "values",
  "secret",
  "secrets",
  "token",
  "tokens",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "plaintext",
  "ciphertext",
  "authorization",
  "cookie",
]);
const SECRET_PHRASES = new Set(["apikey", "privatekey"]);
// ...unless the last word says it only describes one (`secret_count`, `token_id`).
const DESCRIBES = new Set([
  "count",
  "counts",
  "id",
  "ids",
  "name",
  "names",
  "kind",
  "type",
  "length",
]);

const MAX_JSON = 4096;
const MAX_STRING = 256;
const MAX_ITEMS = 100;
const MAX_DEPTH = 3;

function forbiddenKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (SECRET_PHRASES.has(words.join(""))) return true;
  if (DESCRIBES.has(words.at(-1) ?? "")) return false;
  return words.some((w) => SECRET_WORDS.has(w));
}

function check(node: unknown, path: string, depth: number): void {
  if (node === null || typeof node === "boolean") return;
  if (typeof node === "number") {
    if (!Number.isFinite(node))
      throw new AuditError(`audit metadata ${path} is not a finite number`);
    return;
  }
  if (typeof node === "string") {
    // A long string is more likely a pasted value than an id or a key name.
    if (node.length > MAX_STRING) throw new AuditError(`audit metadata ${path} is too long`);
    return;
  }
  if (typeof node !== "object") throw new AuditError(`audit metadata ${path} must be plain JSON`);
  if (depth >= MAX_DEPTH) throw new AuditError(`audit metadata ${path} is nested too deeply`);
  if (Array.isArray(node)) {
    if (node.length > MAX_ITEMS) throw new AuditError(`audit metadata ${path} has too many items`);
    for (const [i, item] of node.entries()) check(item, `${path}[${i}]`, depth + 1);
    return;
  }
  if (Object.getPrototypeOf(node) === Object.prototype) {
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue;
      if (forbiddenKey(k)) {
        throw new AuditError(
          `audit metadata key "${k}" is not allowed: record ids, key names and counts, never values`,
        );
      }
      check(v, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new AuditError(`audit metadata ${path} must be plain JSON`);
}

/** Throws unless `metadata` is small, plain JSON without secret-looking keys; returns it. */
export function checkMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  check(metadata, "metadata", 0);
  if (JSON.stringify(metadata).length > MAX_JSON)
    throw new AuditError("audit metadata is too large");
  return metadata;
}

const ACTION = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const TYPE = /^[a-z0-9_]+$/;

/**
 * Appends one audit event inside `tx`, so it commits with the change it records and rolls back
 * with it. The table rejects UPDATE, DELETE and TRUNCATE.
 */
export async function audit(tx: Tx, ctx: AuditContext, e: AuditEvent): Promise<void> {
  // The type already says "transaction"; this catches a cast or an untyped caller.
  if (typeof (tx as { rollback?: unknown }).rollback !== "function") {
    throw new AuditError("audit() must run inside the transaction of the change it records");
  }
  if (!ACTION.test(e.action)) throw new AuditError("audit action must look like `resource.verb`");
  if (!TYPE.test(e.resourceType)) throw new AuditError("audit resourceType must be snake_case");
  if (!ctx.actor.kind || !ctx.actor.id) throw new AuditError("audit needs an actor");
  await tx.insert(auditEvents).values({
    actorKind: ctx.actor.kind,
    actorId: ctx.actor.id,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    organizationId: e.organizationId,
    projectId: e.projectId,
    metadata: checkMetadata(e.metadata ?? {}),
    requestId: ctx.requestId,
    ip: ctx.ip,
  });
}
