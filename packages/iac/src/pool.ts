/** What the generator needs of a worker pool (the organization's record, see `@orch/db` `WorkerPool`). */
export interface PoolRef {
  name: string;
  tags: string[];
  image: string | null;
  enabled: boolean;
  isDefault: boolean;
}

/**
 * Which pool a stack's jobs run on. `unknown` and `disabled` are not "none": the caller must refuse
 * them, because a stack that asked for its own runners must not quietly run on shared ones.
 */
export type PoolResolution =
  | { kind: "none" }
  | { kind: "pool"; pool: PoolRef }
  | { kind: "unknown"; name: string }
  | { kind: "disabled"; name: string };

/**
 * The pool a stack names, else the organization's default, else none (today's behaviour). Judged on
 * the pools as they are now, so a change of default reaches stacks that name none at their next plan.
 */
export function resolvePool(named: string | undefined, pools: readonly PoolRef[]): PoolResolution {
  const pool =
    named === undefined ? pools.find((p) => p.isDefault) : pools.find((p) => p.name === named);
  if (!pool) return named === undefined ? { kind: "none" } : { kind: "unknown", name: named };
  return pool.enabled ? { kind: "pool", pool } : { kind: "disabled", name: pool.name };
}
