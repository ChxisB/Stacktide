import { createHash } from "node:crypto";
import { DomainError, type Logger, resolveVariables } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type ChainEntry,
  createSyncRun,
  type Db,
  type Executor,
  listEnvironments,
  openChain,
  type SyncTarget,
} from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import {
  ALL_SCOPES,
  AWS_SM,
  AWS_SSM,
  awsSmAdapter,
  awsSsmAdapter,
  checkItems,
  GITLAB_VARIABLES,
  type GuardrailConfig,
  gitlabVariablesAdapter,
  type ItemInput,
  isProtected,
  KUBERNETES_SECRET,
  kubernetesSecretAdapter,
  type PlanAction,
  plan,
  refId,
  type SyncAdapter,
  SyncError,
  type UnmanagedPolicy,
  VAULT_KV,
  vaultKvAdapter,
} from "@orch/sync";
import {
  type CloudDeps,
  openAwsSession,
  openGitlabConnection,
  openKubernetesConnection,
  openVaultConnection,
} from "./connections";
import { guardrailRefusal } from "./guardrails";
import { type ReferenceDeps, resolveReferences, substitute } from "./references";

/** A key that could not be resolved at a scope, and why. Names only, never a value. */
export interface Unresolved {
  key: string;
  scope: string;
  code: string;
}

export interface Desired {
  /** What the target should hold: the project's variables at `*`, an environment's overrides at its scope. */
  items: ItemInput[];
  /** What the plan must not touch on the target: nothing is wanted there, but nothing is known to be unwanted either. */
  unresolved: Unresolved[];
  /** Mapped environments that no longer exist: their scope is not synced. */
  missingEnvironments: string[];
  /** The scopes the plan leaves alone: refs on the target in those scopes are not in the plan. */
  leftAlone: Set<string>;
  /** Which variables, versions and settings this was made from. No value goes in. */
  digest: string;
}

const sorted = <T>(rows: T[], by: (row: T) => string) =>
  rows.sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));

/** What a desired state is made of, read in one snapshot: the opened variables of the project and of each mapped environment. */
interface Gathered {
  base: ChainEntry[];
  environments: {
    slug: string;
    scope: string;
    /** Undefined for an environment that no longer exists. */
    environmentId: string | undefined;
    chain: ChainEntry[];
  }[];
}

/** Everything `desiredState` reads from the database. Opens every secret of the project: the caller must have checked that it may. */
async function gather(db: Executor, keys: KeyProvider, target: SyncTarget): Promise<Gathered> {
  const { organizationId, projectId } = target;
  const known = new Map(
    (await listEnvironments(db, organizationId, projectId)).map((e) => [e.slug, e.id]),
  );
  const base = await openChain(db, keys, { organizationId, projectId });
  const environments: Gathered["environments"] = [];
  for (const [slug, scope] of Object.entries(target.environmentMapping).sort()) {
    const environmentId = known.get(slug);
    // shortcut: the shared levels are opened again for each environment; cache them if plans get slow
    const chain = environmentId
      ? await openChain(db, keys, { organizationId, projectId, environmentId })
      : [];
    environments.push({ slug, scope, environmentId, chain });
  }
  return { base, environments };
}

/**
 * Which variables, versions and settings the state is made from. No value goes in, so what a reference
 * points at is not part of it: a value that changes in its store between a plan and its apply is read
 * again at the apply and written as it is then.
 */
function digestOf(target: SyncTarget, g: Gathered) {
  const facts: unknown[] = [chainFacts(g.base)];
  for (const { slug, scope, environmentId, chain } of g.environments) {
    if (environmentId) facts.push([slug, scope, environmentId, chainFacts(chain)]);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.type,
        target.connectionId,
        target.config,
        // key order must not matter
        Object.entries(target.environmentMapping).sort(),
        target.unmanagedPolicy,
        facts,
      ]),
    )
    .digest("hex");
}

/**
 * What a sync target should hold for a project (SYNC-5). The project's variables, references filled
 * in, go to `*`; for each mapped environment, only what differs from that (a variable of its own, or
 * one that reads a value it overrides) goes to the environment's scope, where GitLab prefers it.
 * A key that cannot be resolved is not wanted anywhere it fails, and is reported, so a broken
 * reference never reads as "delete it". `resolved` is what the external references of the winning
 * variables came to (EXT-6).
 */
function assemble(target: SyncTarget, g: Gathered, resolved: ReadonlyMap<string, string>): Desired {
  const { variables, issues } = resolveVariables(substitute(g.base, resolved));
  const baseOf = new Map(variables.map((v) => [v.key, v]));
  const items: ItemInput[] = variables.map((v) => ({
    key: v.key,
    scope: ALL_SCOPES,
    value: v.value,
    secret: v.kind === "secret",
    file: v.kind === "file",
  }));

  const unresolved: Unresolved[] = [];
  const missingEnvironments: string[] = [];
  const leftAlone = new Set<string>();
  const resolvedInAnEnvironment = new Set<string>();

  for (const { slug, scope, environmentId, chain } of g.environments) {
    if (!environmentId) {
      missingEnvironments.push(slug);
      leftAlone.add(scope);
      continue;
    }
    const there = resolveVariables(substitute(chain, resolved));
    for (const v of there.variables) {
      resolvedInAnEnvironment.add(v.key);
      const own = baseOf.get(v.key);
      if (own && own.value === v.value && own.kind === v.kind) continue;
      items.push({
        key: v.key,
        scope,
        value: v.value,
        secret: v.kind === "secret",
        file: v.kind === "file",
      });
    }
    for (const issue of there.issues) unresolved.push({ key: issue.key, scope, code: issue.code });
  }
  // A key that reads something only the environments define has no value at `*`, and that is fine
  // when an environment resolves it; when none does, it is broken.
  for (const issue of issues) {
    if (!resolvedInAnEnvironment.has(issue.key)) {
      unresolved.push({ key: issue.key, scope: ALL_SCOPES, code: issue.code });
    }
  }

  return {
    items,
    unresolved: sorted(unresolved, (u) => JSON.stringify([u.key, u.scope])),
    missingEnvironments,
    leftAlone,
    digest: digestOf(target, g),
  };
}

/** Which variables (by id) a chain is made of and the version of each: enough to see that one changed, no value. */
const chainFacts = (chain: { id: string; key: string; kind: string; version: number }[]) =>
  sorted(
    chain.map(({ id, key, kind, version }) => [id, key, kind, version] as const),
    (row) => row[0],
  );

/** The refs the plan must not mention: unresolved ones and everything in a scope that is not synced. */
export const untouchable = (d: Desired) => {
  const refs = new Set(d.unresolved.map(refId));
  return (item: { key: string; scope: string }) =>
    refs.has(refId(item)) || d.leftAlone.has(item.scope);
};

/** The variables in one snapshot, so that they and the digest are of the same moment. */
const snapshot = (db: Db, keys: KeyProvider, target: SyncTarget) =>
  db.transaction((tx) => gather(tx, keys, target), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

/**
 * The digest of what a target should hold, without reading the stores that references point at: it does
 * not depend on them. For the check that a plan is still true.
 */
export async function snapshotDigest(db: Db, keys: KeyProvider, target: SyncTarget) {
  return digestOf(target, await snapshot(db, keys, target));
}

/**
 * What a sync target should hold. The variables are read in one snapshot; the external references of
 * the ones that win are read after it, so no store is waited for while a transaction is open. A
 * reference that cannot be read fails the call (see `resolveReferences`). Opens every secret of the
 * project and the connections its references name: the caller must have checked that it may.
 */
export async function desiredSnapshot(
  deps: ReferenceDeps,
  target: SyncTarget,
  requestId: unknown,
): Promise<Desired> {
  const gathered = await snapshot(deps.db, deps.keys, target);
  const resolved = await resolveReferences(deps, target.organizationId, requestId, [
    gathered.base,
    ...gathered.environments.map((e) => e.chain),
  ]);
  return assemble(target, gathered, resolved);
}

/**
 * The adapter for a target, reaching it with its connection's credential (opened here, held only by
 * the client). The type decides which kind of connection it needs; the sync-targets route checked
 * that when the target was made, and the connection's own type is checked again here.
 *
 * shortcut: a switch on the type, one case per kind of target; a registry only pays off with many.
 */
export async function openTarget(
  deps: { db: Db; keys: KeyProvider; logger: Logger; cloud?: CloudDeps | undefined },
  target: SyncTarget,
  requestId: unknown,
): Promise<SyncAdapter<unknown>> {
  const { organizationId, connectionId } = target;
  switch (target.type) {
    case GITLAB_VARIABLES: {
      const { baseUrl, token } = await openGitlabConnection(
        deps,
        organizationId,
        connectionId,
        requestId,
      );
      return gitlabVariablesAdapter(
        createGitlab({
          baseUrl,
          auth: { type: "private-token", token },
          timeoutMs: 15_000,
          maxRetries: 1,
          maxRetryDelayMs: 2_000,
        }),
      );
    }
    case AWS_SSM: {
      const { aws, session } = await openAwsSession(deps, organizationId, connectionId, requestId);
      return awsSsmAdapter(session, aws);
    }
    case AWS_SM: {
      const { aws, session } = await openAwsSession(deps, organizationId, connectionId, requestId);
      return awsSmAdapter(session, aws);
    }
    case KUBERNETES_SECRET: {
      const { config, token } = await openKubernetesConnection(
        deps,
        organizationId,
        connectionId,
        requestId,
      );
      return kubernetesSecretAdapter(config, token, {
        fetch: deps.cloud?.fetch ?? globalThis.fetch,
      });
    }
    case VAULT_KV: {
      const { config, token } = await openVaultConnection(
        deps,
        organizationId,
        connectionId,
        requestId,
      );
      return vaultKvAdapter(config, token, { fetch: deps.cloud?.fetch ?? globalThis.fetch });
    }
  }
  throw new DomainError("target_type", 422, "This type of sync target cannot be used");
}

/** How long a plan can be applied for: long enough to read it, short enough that it is still true. */
const PLAN_TTL_MS = 15 * 60_000;
export const ACTIONS = ["create", "update", "delete", "noop", "adopt"] as const;
/** The plan_invalid message names this many items, then counts the rest. */
const MAX_NAMED = 10;

/** What the target's own words amount to. They name keys and scopes, never a value (the adapter has already put GitLab's failures into its own words). */
const targetError = (e: unknown) => {
  if (!(e instanceof SyncError)) return e;
  return e.kind === "failed"
    ? new DomainError("target_failed", 502, e.message)
    : new DomainError("plan_invalid", 422, e.message);
};

/** Every wanted item the target can never hold, named, so one plan shows all of them at once. */
function refuse(adapter: Pick<SyncAdapter<unknown>, "check">, items: ItemInput[]) {
  const refused: string[] = [];
  for (const item of items) {
    try {
      adapter.check(item);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      refused.push(e.message);
    }
  }
  if (refused.length === 0) return;
  const more = refused.length - MAX_NAMED;
  const named = refused.slice(0, MAX_NAMED).join("; ");
  throw new DomainError(
    "plan_invalid",
    422,
    `The target cannot hold ${refused.length} variable(s), nothing was planned: ${named}${more > 0 ? `; and ${more} more` : ""}`,
  );
}

export interface Planned {
  desired: Desired;
  items: ReturnType<typeof plan>;
}

/**
 * What the project's variables would change on a target: reads the target and compares, writes
 * nothing. Opens every secret of the project and the connection's token, so the caller must have
 * checked that it may. A `DomainError` for what is wrong with the target (422 `plan_invalid`, 502
 * `target_failed`, 422 `guardrail_violation`); a `CryptoError` when a stored secret cannot be opened.
 */
export async function planTarget(
  deps: {
    db: Db;
    keys: KeyProvider;
    logger: Logger;
    guardrails?: GuardrailConfig | undefined;
    cloud?: CloudDeps | undefined;
  },
  target: SyncTarget,
  requestId: unknown,
  /** What to do with what the target holds that nothing here wants; the target's own policy when left out. */
  unmanaged: UnmanagedPolicy = target.unmanagedPolicy as UnmanagedPolicy,
): Promise<Planned> {
  const adapter = await openTarget(deps, target, requestId);
  try {
    // before any secret is opened: a target that cannot be planned costs nothing
    const config = adapter.validate(target.config);
    const desired = await desiredSnapshot(deps, target, requestId);
    refuse(adapter, desired.items);
    const violations = checkItems(
      desired.items,
      { protected: isProtected(config) },
      deps.guardrails,
    );
    if (violations.length > 0) throw guardrailRefusal("The plan", violations);
    const skip = untouchable(desired);
    const actual = (await adapter.connect(config).read()).filter((i) => !skip(i));
    const items = plan(desired.items, actual, { unmanaged });
    return { desired, items };
  } catch (e) {
    throw targetError(e);
  }
}

/** How many lines a plan has of each action. */
export function countActions(items: Planned["items"]) {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
  for (const item of items) counts[item.action]++;
  return counts;
}

/** Stores a plan as a run that can be applied for a while. The caller audits it. */
export function storePlan(tx: Executor, target: SyncTarget, { desired, items }: Planned) {
  const counts = countActions(items);
  return createSyncRun(
    tx,
    {
      organizationId: target.organizationId,
      projectId: target.projectId,
      targetId: target.id,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS),
      desiredDigest: desired.digest,
      counts,
      skipped: { unresolved: desired.unresolved, missingEnvironments: desired.missingEnvironments },
    },
    items,
  );
}
