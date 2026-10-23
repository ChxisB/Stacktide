import { ROOT } from "./folders";
import type { BulkOp } from "./variables";

/** open -> approved -> applied, or rejected, or expired; a variable change is approved and applied in one step. */
export const CHANGE_REQUEST_STATUSES = [
  "open",
  "approved",
  "applied",
  "rejected",
  "expired",
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

/**
 * What a change request carries: edits to the variables of an environment (GOV-2), leave to
 * apply a plan to a target or stacks that a protected environment guards (GOV-3), or leave to
 * deploy a commit to a protected environment (DEP-16).
 */
export const CHANGE_REQUEST_KINDS = ["variables", "sync_apply", "iac_apply", "deploy"] as const;
export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];

/** The kinds that approve an apply: nothing is sealed or applied by approving, the apply uses the approval up. */
export const APPLY_KINDS = ["sync_apply", "iac_apply"] as const;
export type ApplyKind = (typeof APPLY_KINDS)[number];

/**
 * What an apply approval is for: the run (a sync plan or an IaC run) and, for sync, its target; for
 * IaC the stacks, each at the plan job it was approved at, so a plan made again needs a new approval.
 */
export interface ApplySubject {
  runId: string;
  targetId?: string;
  stacks?: Record<string, number>;
  /** A `deploy` request has no run (the environment is the one it is made in): it names the commit it lets through. */
  sha?: string;
}

/** How long a request waits for a decision before the expiry job closes it. */
export const CHANGE_REQUEST_TTL_DAYS = 7;

/** Open requests one environment holds at most: a proposal is the one write a developer has, and each seals up to 1 MiB. */
export const CHANGE_REQUEST_MAX_OPEN = 50;

/** One line of what a request would do: key names and actions, never a value. */
export interface DiffEntry {
  /** `apply`: the key is the sync target or the stack that would be applied. */
  action: "set" | "rename" | "delete" | "apply";
  key: string;
  /** The folder of a variable step; absent for the root, and for an `apply`. */
  folder?: string;
  /** The kind a `set` was asked to make (it may be left to the existing variable). */
  kind?: string;
  /** The new key of a `rename`. */
  to?: string;
}

/** What approvers and the audit trail see of `ops`: the same steps with the values left out. */
export const diffOf = (ops: readonly BulkOp[]): DiffEntry[] =>
  ops.map((o) => {
    const folder = o.folder && o.folder !== ROOT ? { folder: o.folder } : {};
    return o.op === "set"
      ? { action: "set", key: o.key, ...(o.kind && { kind: o.kind }), ...folder }
      : o.op === "rename"
        ? { action: "rename", key: o.key, to: o.to, ...folder }
        : { action: "delete", key: o.key, ...folder };
  });

/** Who is who: `user:<id>` for a person however they signed in, else `<kind>:<id>`. Two refs that are equal are one decider. */
export const personRef = (p: { kind: string; id: string; userId?: string | undefined }) =>
  p.userId ? `user:${p.userId}` : `${p.kind}:${p.id}`;
