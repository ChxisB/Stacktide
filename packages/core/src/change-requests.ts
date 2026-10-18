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

/** What a change request carries. Only variable edits so far (GOV-2). */
export const CHANGE_REQUEST_KINDS = ["variables"] as const;
export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];

/** How long a request waits for a decision before the expiry job closes it. */
export const CHANGE_REQUEST_TTL_DAYS = 7;

/** Open requests one environment holds at most: a proposal is the one write a developer has, and each seals up to 1 MiB. */
export const CHANGE_REQUEST_MAX_OPEN = 50;

/** One line of what a request would do: key names and actions, never a value. */
export interface DiffEntry {
  action: "set" | "rename" | "delete";
  key: string;
  /** The kind a `set` was asked to make (it may be left to the existing variable). */
  kind?: string;
  /** The new key of a `rename`. */
  to?: string;
}

/** What approvers and the audit trail see of `ops`: the same steps with the values left out. */
export const diffOf = (ops: readonly BulkOp[]): DiffEntry[] =>
  ops.map((o) =>
    o.op === "set"
      ? { action: "set", key: o.key, ...(o.kind && { kind: o.kind }) }
      : o.op === "rename"
        ? { action: "rename", key: o.key, to: o.to }
        : { action: "delete", key: o.key },
  );

/** Who is who: `user:<id>` for a person however they signed in, else `<kind>:<id>`. Two refs that are equal are one decider. */
export const personRef = (p: { kind: string; id: string; userId?: string | undefined }) =>
  p.userId ? `user:${p.userId}` : `${p.kind}:${p.id}`;
