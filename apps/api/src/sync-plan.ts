import { createHash } from "node:crypto";
import { type Logger, resolveVariables } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { type Db, type Executor, listEnvironments, openChain, type SyncTarget } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { ALL_SCOPES, gitlabVariablesAdapter, type ItemInput, refId } from "@orch/sync";
import { openGitlabConnection } from "./connections";

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

/**
 * What a sync target should hold for a project (SYNC-5). The project's variables, references filled
 * in, go to `*`; for each mapped environment, only what differs from that (a variable of its own, or
 * one that reads a value it overrides) goes to the environment's scope, where GitLab prefers it.
 * A key that cannot be resolved is not wanted anywhere it fails, and is reported, so a broken
 * reference never reads as "delete it". Opens every secret of the project: the caller must have
 * checked that it may.
 */
export async function desiredState(
  db: Executor,
  keys: KeyProvider,
  target: SyncTarget,
): Promise<Desired> {
  const { organizationId, projectId } = target;
  const known = new Map(
    (await listEnvironments(db, organizationId, projectId)).map((e) => [e.slug, e.id]),
  );

  const base = await openChain(db, keys, { organizationId, projectId });
  const { variables, issues } = resolveVariables(base);
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
  const facts: unknown[] = [chainFacts(base)];

  for (const [slug, scope] of Object.entries(target.environmentMapping).sort()) {
    const environmentId = known.get(slug);
    if (!environmentId) {
      missingEnvironments.push(slug);
      leftAlone.add(scope);
      continue;
    }
    // shortcut: the shared levels are opened again for each environment; cache them if plans get slow
    const chain = await openChain(db, keys, { organizationId, projectId, environmentId });
    const there = resolveVariables(chain);
    facts.push([slug, scope, environmentId, chainFacts(chain)]);
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

  const digest = createHash("sha256")
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
  return {
    items,
    unresolved: sorted(unresolved, (u) => JSON.stringify([u.key, u.scope])),
    missingEnvironments,
    leftAlone,
    digest,
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

/** `desiredState` in one snapshot, so the variables, the lines and the digest are of the same moment. */
export const desiredSnapshot = (db: Db, keys: KeyProvider, target: SyncTarget) =>
  db.transaction((tx) => desiredState(tx, keys, target), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

/** The adapter for a target, reaching it with its connection's token (opened here, held only by the client). */
export async function openTarget(
  deps: { db: Db; keys: KeyProvider; logger: Logger },
  target: SyncTarget,
  requestId: unknown,
) {
  const { baseUrl, token } = await openGitlabConnection(
    deps,
    target.organizationId,
    target.connectionId,
    requestId,
  );
  // shortcut: one target type; a registry of builders replaces this when a second one comes
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
