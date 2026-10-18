import { DomainError, type Logger, VARIABLE_LEVELS } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { type ChainEntry, type Db, getConnectionByName } from "@orch/db";
import {
  AWS_ASSUME_ROLE,
  awsReferenceReader,
  isReference,
  parseReference,
  REFERENCE_WHY,
  ReferenceFailure,
  type ReferenceReader,
  VAULT_APPROLE,
  vaultReferenceReader,
} from "@orch/sync";
import { type CloudDeps, openAwsSession, openVaultConnection } from "./connections";

export interface ReferenceDeps {
  db: Db;
  keys: KeyProvider;
  logger: Logger;
  cloud?: CloudDeps | undefined;
}

/**
 * Different references one plan or apply reads. Nothing is kept between passes, so this and the size of
 * a value are the whole of what a pass can cost the stores.
 */
export const MAX_REFERENCES = 50;
/** A message names this many variables, then counts the rest. */
const MAX_NAMED = 10;

/** The entries that win their key: the most specific level that has it (several at that level all stay, they are a duplicate). */
function winners<T extends Pick<ChainEntry, "key" | "level">>(chain: readonly T[]): Set<T> {
  const best = new Map<string, number>();
  for (const e of chain) {
    best.set(e.key, Math.max(best.get(e.key) ?? -1, VARIABLE_LEVELS.indexOf(e.level)));
  }
  return new Set(chain.filter((e) => VARIABLE_LEVELS.indexOf(e.level) === best.get(e.key)));
}

/**
 * The chain with the references of its winning entries replaced by what they resolved to. A value that
 * was `plain` becomes a `secret`: it came out of a secret store. The text is escaped so that a `${` in
 * it stays literal when the variables are resolved; a `file` is not read for references anyway.
 */
export function substitute<T extends Pick<ChainEntry, "key" | "level" | "kind" | "value">>(
  chain: readonly T[],
  resolved: ReadonlyMap<string, string>,
): T[] {
  const won = winners(chain);
  return chain.map((e) => {
    const value = won.has(e) ? resolved.get(e.value) : undefined;
    if (value === undefined) return e;
    return {
      ...e,
      kind: e.kind === "plain" ? "secret" : e.kind,
      // a function: in a replacement string `$$` means one `$`
      value: e.kind === "file" ? value : value.replaceAll("${", () => "$${"),
    };
  });
}

/** A connection that cannot be used for what a reference asks of it: the reference is wrong, not the store. */
const CONFIG: ReadonlySet<string> = new Set([
  "malformed",
  "unknown_connection",
  "wrong_connection",
  "not_enabled",
]);

/**
 * A reader for a connection named in a reference, in the organization of the variables. It must exist,
 * be of a kind that holds secrets, and have been created with `references: true`: pointing at a store
 * is something an owner of the connection allows, not something every writer of a variable may do.
 */
async function readerFor(
  deps: ReferenceDeps,
  organizationId: string,
  name: string,
  requestId: unknown,
): Promise<ReferenceReader> {
  const found = await getConnectionByName(deps.db, organizationId, name);
  if (!found) throw new ReferenceFailure("unknown_connection");
  if (found.type !== VAULT_APPROLE && found.type !== AWS_ASSUME_ROLE) {
    throw new ReferenceFailure("wrong_connection");
  }
  if (found.config.references !== true) throw new ReferenceFailure("not_enabled");
  const fetch = deps.cloud?.fetch ?? globalThis.fetch;
  if (found.type === VAULT_APPROLE) {
    const { config, token } = await openVaultConnection(deps, organizationId, found.id, requestId);
    return vaultReferenceReader(config, token, { fetch });
  }
  const { aws, session, region } = await openAwsSession(deps, organizationId, found.id, requestId);
  return awsReferenceReader({ region }, session, aws);
}

/**
 * Reads what the references of the winning entries of these chains point at, once for each different
 * reference: the value by the text of the reference. Nothing is cached after the call, every credential
 * it opened is let go before it returns, and nothing it reads is stored or logged.
 *
 * Any reference that cannot be read fails the whole call (`reference_invalid` 422 when it is the
 * reference or its connection that is wrong, `reference_failed` 502 when the store would not give it),
 * naming the variables and saying why in fixed words, so a plan never reads a broken reference as
 * "delete it". A `DomainError` from opening a connection passes through.
 */
export async function resolveReferences(
  deps: ReferenceDeps,
  organizationId: string,
  requestId: unknown,
  chains: readonly (readonly Pick<ChainEntry, "key" | "level" | "value">[])[],
): Promise<Map<string, string>> {
  /** Reference → the keys that hold it. */
  const wanted = new Map<string, Set<string>>();
  for (const chain of chains) {
    for (const e of winners(chain)) {
      if (!isReference(e.value)) continue;
      const keys = wanted.get(e.value) ?? new Set<string>();
      wanted.set(e.value, keys.add(e.key));
    }
  }
  const resolved = new Map<string, string>();
  if (wanted.size === 0) return resolved;
  if (wanted.size > MAX_REFERENCES) {
    throw new DomainError(
      "reference_invalid",
      422,
      `${wanted.size} different references would be read at once; at most ${MAX_REFERENCES} are read in one go`,
    );
  }

  const readers = new Map<string, Promise<ReferenceReader>>();
  const failures = new Map<string, ReferenceFailure>();
  let unexpected: unknown;
  try {
    await Promise.all(
      [...wanted.keys()].map(async (text) => {
        try {
          const ref = parseReference(text);
          let reader = readers.get(ref.connection);
          if (!reader) {
            reader = readerFor(deps, organizationId, ref.connection, requestId);
            readers.set(ref.connection, reader);
          }
          resolved.set(text, await (await reader).read(ref));
        } catch (e) {
          if (e instanceof ReferenceFailure) failures.set(text, e);
          else unexpected ??= e;
        }
      }),
    );
  } finally {
    await Promise.allSettled([...readers.values()].map((r) => r.then((reader) => reader.close())));
  }
  if (unexpected !== undefined) throw unexpected;
  if (failures.size === 0) return resolved;

  const named = [...failures].flatMap(([text, failure]) =>
    [...(wanted.get(text) ?? [])].map((key) => ({ key, failure })),
  );
  named.sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)));
  deps.logger.warn("references could not be read", {
    request_id: requestId,
    failed: failures.size,
    reasons: [...new Set([...failures.values()].map((f) => f.reason))].sort(),
  });
  const shown = named
    .slice(0, MAX_NAMED)
    .map(({ key, failure }) => `${key} ${REFERENCE_WHY[failure.reason]}`)
    .join("; ");
  const more = named.length - MAX_NAMED;
  const invalid = [...failures.values()].some((f) => CONFIG.has(f.reason));
  throw new DomainError(
    invalid ? "reference_invalid" : "reference_failed",
    invalid ? 422 : 502,
    `${named.length} variable(s) hold a reference that could not be used, so nothing is synced: ${shown}${more > 0 ? `; and ${more} more` : ""}`,
  );
}
