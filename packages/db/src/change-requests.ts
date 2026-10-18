import {
  type ApplyKind,
  type ApplySubject,
  type BulkOp,
  type ChangeRequestStatus,
  type DiffEntry,
  diffOf,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { and, desc, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { type Executor, lockEnvironment, type Page } from "./repo";
import { changeRequests, environments } from "./schema";
import { type Bulked, bulkLevel, bulkPlan, openPending, sealPending } from "./variables";

export const CHANGE_REQUEST_EXPIRE_QUEUE = "change_request.expire";

const { opsEnc: _sealed, ...visible } = getTableColumns(changeRequests);

/** A change request as everyone who may read it sees it: what it would do by name, never a value. */
export type ChangeRequest = Omit<typeof changeRequests.$inferSelect, "opsEnc" | "diff"> & {
  diff: DiffEntry[];
};

/** Who: as the audit trail names them (`kind`, `id`) and as a person (`ref`, see `personRef`). */
export interface Person {
  kind: string;
  id: string;
  ref: string;
}

interface At {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

const inEnv = (at: At) =>
  and(
    eq(changeRequests.organizationId, at.organizationId),
    eq(changeRequests.projectId, at.projectId),
    eq(changeRequests.environmentId, at.environmentId),
  );
const requestIs = (at: At, id: string) => and(inEnv(at), eq(changeRequests.id, id));

/**
 * Seals `ops` and stores the request, open until `expiresAt`. The diff is made here from the edits,
 * so what is shown is always what is sealed. The caller checks the shape of `ops` (the bulk-edit
 * schema): nothing is compared with the stored values, so asking reveals nothing about them.
 */
export async function createChangeRequest(
  db: Executor,
  keys: KeyProvider,
  input: At & { ops: readonly BulkOp[]; author: Person; expiresAt: Date },
): Promise<ChangeRequest> {
  const id = Bun.randomUUIDv7();
  const opsEnc = await sealPending(db, keys, { ...input, id }, input.ops);
  const [row] = await db
    .insert(changeRequests)
    .values({
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      kind: "variables",
      diff: diffOf(input.ops),
      opsEnc,
      authorKind: input.author.kind,
      authorId: input.author.id,
      authorRef: input.author.ref,
      expiresAt: input.expiresAt,
    })
    .returning(visible);
  if (!row) throw new Error("insert returned no row");
  return row as ChangeRequest;
}

/**
 * Stores a request for leave to apply a plan (GOV-3), open until `expiresAt`. Nothing is sealed:
 * `subject` names the run (and its target, or its stacks at their plan jobs) and `diff` what the
 * approver is shown. The caller has checked that they exist and are planned.
 */
export async function createApplyRequest(
  db: Executor,
  input: At & {
    kind: ApplyKind;
    subject: ApplySubject;
    diff: DiffEntry[];
    author: Person;
    expiresAt: Date;
  },
): Promise<ChangeRequest> {
  const { runId, ...rest } = input.subject;
  const [row] = await db
    .insert(changeRequests)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      kind: input.kind,
      diff: input.diff,
      subjectId: runId,
      subject: rest,
      authorKind: input.author.kind,
      authorId: input.author.id,
      authorRef: input.author.ref,
      expiresAt: input.expiresAt,
    })
    .returning(visible);
  if (!row) throw new Error("insert returned no row");
  return row as ChangeRequest;
}

export async function getChangeRequest(
  db: Executor,
  at: At,
  id: string,
): Promise<ChangeRequest | undefined> {
  const [row] = await db.select(visible).from(changeRequests).where(requestIs(at, id));
  return row as ChangeRequest | undefined;
}

/** Newest first (ids are time-ordered); `after` is the last id of the previous page. */
export async function listChangeRequests(
  db: Executor,
  at: At,
  filter: { status?: ChangeRequestStatus | undefined },
  page: Page<[string]>,
): Promise<ChangeRequest[]> {
  const rows = await db
    .select(visible)
    .from(changeRequests)
    .where(
      and(
        inEnv(at),
        filter.status === undefined ? undefined : eq(changeRequests.status, filter.status),
        page.after ? lt(changeRequests.id, page.after[0]) : undefined,
      ),
    )
    .orderBy(desc(changeRequests.id))
    .limit(page.limit);
  return rows as ChangeRequest[];
}

/** Why a request was not applied. */
export type Approval =
  | { result: "not_found" }
  | { result: "closed"; status: ChangeRequestStatus }
  | { result: "expired" }
  | { result: "self" }
  | { result: "conflict"; keys: string[] }
  | { result: "applied"; request: ChangeRequest; changes: Bulked[] }
  /** A request to apply a plan: decided, and used up when the apply starts (`consumeApproval`). */
  | { result: "approved"; request: ChangeRequest };

/**
 * Approves and applies a request in the caller's transaction (the caller audits in it too; any
 * result but `applied` changes nothing). The environment is locked first, so approvals of any
 * requests of it and direct writes take turns, and then the request, so an approval and a
 * rejection do. It must be open, not past its time, and decided by someone other than its author.
 * The edits are planned against the variables as they are now: if any step would no longer do what
 * was asked (a key to rename is gone, a name is taken, a kind differs) the request stays open and
 * nothing is applied. A delete of a key that is already gone is done, not a conflict. Applying is
 * `bulkLevel` as the approver, so the versions it makes name them and the request.
 */
export async function approveChangeRequest(
  tx: Executor,
  keys: KeyProvider | undefined,
  at: At,
  id: string,
  approver: Person,
): Promise<Approval> {
  const [head] = await tx
    .select({ kind: changeRequests.kind })
    .from(changeRequests)
    .where(requestIs(at, id));
  if (head && head.kind !== "variables") return approveApply(tx, at, id, approver);
  // Plan and apply see the same variables: nothing else writes this environment's until we end.
  if (!(await lockEnvironment(tx, at.organizationId, at.projectId, at.environmentId, "update"))) {
    return { result: "not_found" };
  }
  const [row] = await tx
    .select({
      ...getTableColumns(changeRequests),
      lapsed: sql<boolean>`${changeRequests.expiresAt} <= now()`,
    })
    .from(changeRequests)
    .where(requestIs(at, id))
    .for("update");
  if (!row) return { result: "not_found" };
  if (row.status !== "open" || !row.opsEnc)
    return { result: "closed", status: row.status as ChangeRequestStatus };
  if (row.lapsed) return { result: "expired" };
  if (row.authorRef === approver.ref) return { result: "self" };

  if (!keys) throw new Error("approving edits needs the keys that sealed them");
  const ops = await openPending(tx, keys, { ...at, id }, row.opsEnc);
  const scope = {
    organizationId: at.organizationId,
    projectId: at.projectId,
    environmentId: at.environmentId,
  };
  const deleting = new Set(ops.flatMap((o) => (o.op === "delete" ? [o.key] : [])));
  // shortcut: bulkLevel plans again (every secret of the level is opened twice), when approvals are slow enough to matter make it report what it refused
  const wrong = (await bulkPlan(tx, keys, scope, ops)).filter(
    (c) =>
      c.change === "conflict" ||
      c.change === "kind_mismatch" ||
      (c.change === "missing" && !deleting.has(c.key)),
  );
  if (wrong.length > 0) return { result: "conflict", keys: wrong.map((c) => c.key) };

  const changes = await bulkLevel(tx, keys, scope, ops, {
    actor: { kind: approver.kind, id: approver.id },
    reason: `change request ${id}`,
  });
  const [applied] = await tx
    .update(changeRequests)
    .set({
      status: "applied",
      opsEnc: null,
      decidedByKind: approver.kind,
      decidedById: approver.id,
      decidedByRef: approver.ref,
      decidedAt: sql`now()`,
      appliedAt: sql`now()`,
    })
    .where(requestIs(at, id))
    .returning(visible);
  if (!applied) throw new Error("change request vanished while locked");
  return { result: "applied", request: applied as ChangeRequest, changes };
}

/** Approving a request to apply decides it and changes nothing else; the apply uses the approval up. */
async function approveApply(tx: Executor, at: At, id: string, approver: Person): Promise<Approval> {
  const [row] = await tx
    .select({
      status: changeRequests.status,
      authorRef: changeRequests.authorRef,
      lapsed: sql<boolean>`${changeRequests.expiresAt} <= now()`,
    })
    .from(changeRequests)
    .where(requestIs(at, id))
    .for("update");
  if (!row) return { result: "not_found" };
  if (row.status !== "open") return { result: "closed", status: row.status as ChangeRequestStatus };
  if (row.lapsed) return { result: "expired" };
  if (row.authorRef === approver.ref) return { result: "self" };
  const [request] = await tx
    .update(changeRequests)
    .set({
      status: "approved",
      decidedByKind: approver.kind,
      decidedById: approver.id,
      decidedByRef: approver.ref,
      decidedAt: sql`now()`,
    })
    .where(requestIs(at, id))
    .returning(visible);
  if (!request) throw new Error("change request vanished while locked");
  return { result: "approved", request: request as ChangeRequest };
}

/** What an apply needs an approval for. For IaC the stacks it would apply, each at its plan job. */
export interface ApprovalWanted {
  kind: ApplyKind;
  runId: string;
  targetId?: string;
  stacks?: Record<string, number>;
}

const covers = (subject: ChangeRequest["subject"], want: ApprovalWanted) =>
  subject !== null &&
  (want.targetId === undefined || subject.targetId === want.targetId) &&
  Object.entries(want.stacks ?? {}).every(([name, job]) => subject.stacks?.[name] === job);

/**
 * Uses up an approval, in the caller's transaction (the apply it lets through commits or fails with
 * it): the request to apply this run that is approved, not past its time and covers what is wanted
 * becomes applied, and is returned: of those that do, the one that names the fewest stacks (then
 * the oldest), so a broad approval is kept for the apply that needs it. Undefined when there is
 * none. Two applies at once find one approval for one of them: the row is locked, and the other
 * sees it taken. An approval for more stacks than are applied is used up whole.
 */
export async function consumeApproval(
  tx: Executor,
  at: { organizationId: string; projectId: string },
  want: ApprovalWanted,
): Promise<ChangeRequest | undefined> {
  const candidates = await tx
    .select(visible)
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.organizationId, at.organizationId),
        eq(changeRequests.projectId, at.projectId),
        eq(changeRequests.kind, want.kind),
        eq(changeRequests.status, "approved"),
        eq(changeRequests.subjectId, want.runId),
        sql`${changeRequests.expiresAt} > now()`,
      ),
    )
    .orderBy(changeRequests.id)
    .limit(APPROVALS_LOOKED_AT)
    .for("update");
  const width = (c: ChangeRequest) => Object.keys(c.subject?.stacks ?? {}).length;
  const found = (candidates as ChangeRequest[])
    .filter((c) => covers(c.subject, want))
    .reduce<ChangeRequest | undefined>(
      (best, c) => (!best || width(c) < width(best) ? c : best),
      undefined,
    );
  if (!found) return undefined;
  const [used] = await tx
    .update(changeRequests)
    .set({ status: "applied", appliedAt: sql`now()` })
    .where(eq(changeRequests.id, found.id))
    .returning(visible);
  if (!used) throw new Error("change request vanished while locked");
  return used as ChangeRequest;
}

// shortcut: only the oldest 20 approvals of a run are looked at; a run with more than that approved and unused wants some rejected
const APPROVALS_LOOKED_AT = 20;

/** The slugs among `slugs` that are environments of the project and protected. */
export async function protectedEnvironments(
  db: Executor,
  organizationId: string,
  projectId: string,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(
      and(
        eq(environments.organizationId, organizationId),
        eq(environments.projectId, projectId),
        eq(environments.protected, true),
        inArray(environments.slug, [...slugs]),
      ),
    )
    .orderBy(environments.slug);
  return rows.map((r) => r.slug);
}

/**
 * Closes an open request without applying it and drops its sealed edits. An approval to apply that
 * no apply has used yet is closed the same way (revoked). Undefined: not there. `closed`: not open.
 */
export async function rejectChangeRequest(
  tx: Executor,
  at: At,
  id: string,
  decider: Person,
): Promise<
  | { result: "rejected"; request: ChangeRequest }
  | { result: "closed"; status: ChangeRequestStatus }
  | undefined
> {
  const [row] = await tx
    .select({ status: changeRequests.status })
    .from(changeRequests)
    .where(requestIs(at, id))
    .for("update");
  if (!row) return undefined;
  if (row.status !== "open" && row.status !== "approved") {
    return { result: "closed", status: row.status as ChangeRequestStatus };
  }
  const [request] = await tx
    .update(changeRequests)
    .set({
      status: "rejected",
      opsEnc: null,
      decidedByKind: decider.kind,
      decidedById: decider.id,
      decidedByRef: decider.ref,
      decidedAt: sql`now()`,
    })
    .where(requestIs(at, id))
    .returning(visible);
  if (!request) throw new Error("change request vanished while locked");
  return { result: "rejected", request: request as ChangeRequest };
}

/**
 * Closes up to `limit` requests that are past their time, oldest first, and drops their sealed
 * edits. Rows another worker holds are left to it. Returns what it closed, for the audit trail.
 */
export async function expireChangeRequests(tx: Executor, limit: number): Promise<ChangeRequest[]> {
  const due = tx
    .select({ id: changeRequests.id })
    .from(changeRequests)
    .where(
      and(
        inArray(changeRequests.status, ["open", "approved"]),
        sql`${changeRequests.expiresAt} <= now()`,
      ),
    )
    .orderBy(changeRequests.expiresAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await tx
    .update(changeRequests)
    .set({ status: "expired", opsEnc: null })
    .where(inArray(changeRequests.id, due))
    .returning(visible);
  return rows as ChangeRequest[];
}
