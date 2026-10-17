import { SyncError } from "./errors";
import { byKeyThenScope, refId } from "./ref";
import {
  ALL_SCOPES,
  type Capabilities,
  type ItemInput,
  type ItemRef,
  type RemoteItem,
} from "./types";

/**
 * What to do with an item only the target has: leave it out of the plan (`ignore`), list it so it can
 * be brought in (`adopt`, the target is not changed), or delete it (`prune`, always opt-in).
 */
export type UnmanagedPolicy = "ignore" | "adopt" | "prune";

/** `adopt` only reports an item the target has and nothing wants; an apply writes for `create`, `update` and `delete` only. */
export type PlanAction = "create" | "update" | "delete" | "noop" | "adopt";

/** What differs between a wanted item and the target's. Names only, never the values. */
export type ChangedField = "value" | "secret";

/** One line of a plan: which item, and what will happen to it. A plan never holds a value. */
export interface PlanItem extends ItemRef {
  action: PlanAction;
  changed: ChangedField[];
}

/** What was last applied to a target, as keyed fingerprints (HMAC), for values the target will not return. */
export interface LastApplied {
  fingerprint(value: string): string;
  /** The fingerprint of the value last applied to this item, if one was. */
  get(ref: ItemRef): string | undefined;
}

export interface PlanOptions {
  /** Default `ignore`. */
  unmanaged?: UnmanagedPolicy;
  lastApplied?: LastApplied;
  /** With these, a wanted item the target cannot hold (a secret without masking, a scope without scopes) is `unsupported`, not a change that never settles. */
  capabilities?: Capabilities;
}

/**
 * The difference between what the platform wants and what a target holds, one item per key and scope,
 * ordered by key and then scope. Values are compared here, in memory, and left out of the result.
 * A value the target hides is compared with the last applied one; with none, it is updated, as it
 * cannot be known to be right.
 */
export function plan(
  desired: readonly ItemInput[],
  actual: readonly RemoteItem[],
  { unmanaged = "ignore", lastApplied, capabilities }: PlanOptions = {},
): PlanItem[] {
  const remote = new Map<string, RemoteItem>();
  for (const item of actual) {
    const id = refId(item);
    if (remote.has(id))
      throw new SyncError("failed", `${item.key} (${item.scope}) is in the target twice`);
    remote.set(id, item);
  }

  const items: PlanItem[] = [];
  const wanted = new Set<string>();
  for (const want of desired) {
    const id = refId(want);
    if (wanted.has(id))
      throw new SyncError("invalid", `${want.key} (${want.scope}) is wanted twice`);
    wanted.add(id);
    if (capabilities) checkHoldable(want, capabilities);
    const have = remote.get(id);
    const changed = have ? changes(want, have, lastApplied) : [];
    const action = !have ? "create" : changed.length ? "update" : "noop";
    items.push({ key: want.key, scope: want.scope, action, changed });
  }

  for (const [id, item] of remote) {
    if (wanted.has(id) || unmanaged === "ignore") continue;
    items.push({
      key: item.key,
      scope: item.scope,
      action: unmanaged === "prune" ? "delete" : "adopt",
      changed: [],
    });
  }
  return items.sort(byKeyThenScope);
}

function checkHoldable(want: ItemInput, capabilities: Capabilities) {
  if (!capabilities.supportsScopes && want.scope !== ALL_SCOPES)
    throw new SyncError(
      "unsupported",
      `${want.key}: the target has no scopes, so not ${want.scope}`,
    );
  if (want.secret && !capabilities.supportsMasking)
    throw new SyncError(
      "unsupported",
      `${want.key} (${want.scope}) is secret and the target cannot mask it`,
    );
}

function changes(want: ItemInput, have: RemoteItem, lastApplied?: LastApplied): ChangedField[] {
  const changed: ChangedField[] = [];
  if (!sameValue(want, have, lastApplied)) changed.push("value");
  if (have.secret !== want.secret) changed.push("secret");
  return changed;
}

function sameValue(want: ItemInput, have: RemoteItem, lastApplied?: LastApplied) {
  if (have.value !== null) return have.value === want.value;
  // shortcut: a hidden value edited by hand on the target is not seen, only what was last applied is
  const known = lastApplied?.get({ key: want.key, scope: want.scope });
  return known !== undefined && known === lastApplied?.fingerprint(want.value);
}
