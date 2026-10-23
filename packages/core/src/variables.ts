import { address, ROOT, splitAddress } from "./folders";

/** `secret` and `file` values are never shown; `file` is also never interpolated. */
export const VARIABLE_KINDS = ["plain", "secret", "file"] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];

/** Least to most specific: the more specific one wins. */
export const VARIABLE_LEVELS = ["organization", "project", "environment"] as const;
export type VariableLevel = (typeof VARIABLE_LEVELS)[number];

// The database check `variables_key_check` says the same: change both together.
const KEY = "[A-Za-z_][A-Za-z0-9_]{0,254}";
/** What a variable key may be. */
export const KEY_PATTERN = new RegExp(`^${KEY}$`);

// A folder name as a reference writes it, wider than a valid one: `${/Db/KEY}` is a reference that
// is missing, not text that was left alone.
const NAME = "[A-Za-z0-9_-]+";
/**
 * `$${` is a literal `${`; `${KEY}` is a reference to the holder's folder and `${/a/b/KEY}` one to
 * that address. Nothing else is special (`$KEY`, `${KEY:-x}`).
 */
const TOKEN = new RegExp(String.raw`\$\$\{|\$\{(/(?:${NAME}/)*${KEY}|${KEY})\}`, "g");

/**
 * The longest a resolved value may be, in UTF-16 units. Checked as a value is assembled, so a
 * chain that doubles at every step stops at the limit instead of exhausting memory.
 */
export const MAX_RESOLVED_LENGTH = 1_048_576;

/** One live variable of the chain; `ChainEntry` in `@orch/db` has this shape. */
export interface VariableInput {
  id: string;
  level: VariableLevel;
  /** Absent is the root, `/`. */
  folder?: string;
  key: string;
  kind: VariableKind;
  value: string;
}

export interface Resolved {
  /** The variable that won this address. */
  id: string;
  level: VariableLevel;
  /** `/` for the root. */
  folder: string;
  key: string;
  /** What the value must be treated as: `secret` when it was `plain` but reads a secret or a file. */
  kind: VariableKind;
  /** True when `kind` is `secret` only because of what the value references. */
  tainted: boolean;
  /** Plaintext, whatever the kind: the caller decides who may see it. */
  value: string;
}

/**
 * Why a key has no result. Names only, never a value. `folder` is where `key` lives, there only when
 * it is not the root. A `ref` is spelled as the bare key when it is in the folder of `key`, else as
 * its address (`/db/URL`); so is each member of a `path`, but against the root.
 */
export type ResolveIssue =
  | { code: "missing"; key: string; folder?: string; ref: string }
  /** `path` starts and ends with the same variable, and starts with the smallest address of the ring. */
  | { code: "cycle"; key: string; folder?: string; path: string[] }
  /** The key reads `ref`, which has no result itself. */
  | { code: "unresolved"; key: string; folder?: string; ref: string }
  /** Several variables with this address at the most specific level that has it. */
  | { code: "duplicate"; key: string; folder?: string; level: VariableLevel }
  | { code: "too_large"; key: string; folder?: string };

export interface Resolution {
  /** Sorted by address (`/KEY`, `/db/URL`): at the root, by key. An address with an issue is not in here. */
  variables: Resolved[];
  issues: ResolveIssue[];
}

type Part = string | { ref: string };
interface Node {
  input: VariableInput;
  parts: Part[];
  /** Distinct references (as addresses), in order of first use. */
  refs: string[];
}
interface Frame {
  at: string;
  node: Node;
  next: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : Number(a > b));

/** The key and, when it is not the root, the folder of an address: how an issue names a variable. */
function named(at: string): { key: string; folder?: string } {
  const { folder, key } = splitAddress(at);
  return folder === ROOT ? { key } : { key, folder };
}

/** An address as a reader beside `folder` would write it: the bare key in that folder, else the address. */
function shown(at: string, folder: string): string {
  const split = splitAddress(at);
  return split.folder === folder ? split.key : at;
}

/** `value` is held in `folder`: a bare `${KEY}` is that folder's, a path is the address it says. */
function parse(value: string, folder: string | undefined): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index > last) parts.push(value.slice(last, m.index));
    const ref = m[1];
    parts.push(
      ref === undefined ? "${" : { ref: ref.startsWith("/") ? ref : address(folder, ref) },
    );
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return parts;
}

/**
 * Turns the variables that apply to one environment (the organization's, the project's and the
 * environment's, as one list) into the set it sees. Pure.
 *
 * - A variable is its address: its folder and its key. The most specific level wins each address,
 *   and the same key in two folders is two variables. A reference reads the winner, so `${A}` in a
 *   project variable sees an environment's `A` in the same folder, and a variable that references
 *   its own address is a cycle.
 * - `${KEY}` is replaced by the resolved value of `KEY` in the folder of the variable that holds it,
 *   never the root's as a fallback; `${/a/b/KEY}` reads that address. `$${` writes a literal `${`.
 *   Substituted text is not read again. `file` variables are taken as they are (nothing in them is
 *   a reference, and a `$${` in one stays as written) but can be referenced.
 * - A `plain` value that reads a `secret` or a `file` becomes a `secret` (`tainted`), through any
 *   depth of references.
 * - An address that cannot be resolved (missing reference, cycle, duplicate, too large, or reading
 *   one that failed) is left out and explained in `issues`; the rest still resolves. The order of
 *   the input changes nothing. A folder that cannot exist throws: it is a bug in the caller.
 */
export function resolveVariables(inputs: readonly VariableInput[]): Resolution {
  const issues: ResolveIssue[] = [];

  // The most specific level that has the address; several there is a duplicate.
  const candidates = new Map<string, VariableInput[]>();
  for (const input of inputs) {
    const at = address(input.folder, input.key);
    const held = candidates.get(at) ?? [];
    const rank = VARIABLE_LEVELS.indexOf(input.level);
    const heldRank = VARIABLE_LEVELS.indexOf(held[0]?.level ?? input.level);
    if (!held[0] || rank > heldRank) candidates.set(at, [input]);
    else if (rank === heldRank) held.push(input);
  }

  const addresses = [...candidates.keys()].sort(compare);
  const nodes = new Map<string, Node>();
  const duplicated = new Set<string>();
  for (const at of addresses) {
    const [input, ...others] = candidates.get(at) ?? [];
    if (!input) continue;
    if (others.length > 0) {
      duplicated.add(at);
      issues.push({ code: "duplicate", ...named(at), level: input.level });
      continue;
    }
    const parts = input.kind === "file" ? [input.value] : parse(input.value, input.folder);
    const refs = [...new Set(parts.flatMap((p) => (typeof p === "string" ? [] : [p.ref])))];
    nodes.set(at, { input, parts, refs });
  }

  const done = new Map<string, Resolved>();
  const state = new Map<string, "open" | "closed">();
  const cyclic = new Set<string>();

  // Depth first, with an explicit stack: a long chain must not overflow the call stack.
  for (const root of addresses) {
    const rootNode = nodes.get(root);
    if (!rootNode || state.has(root)) continue;
    state.set(root, "open");
    const stack: Frame[] = [{ at: root, node: rootNode, next: 0 }];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const ref = frame.node.refs[frame.next];
      if (ref !== undefined) {
        frame.next += 1;
        const target = nodes.get(ref);
        if (state.get(ref) === "open") {
          const ring = stack.slice(stack.findIndex((f) => f.at === ref)).map((f) => f.at);
          for (const member of ring) cyclic.add(member);
          const from = ring.indexOf([...ring].sort(compare)[0] ?? ref);
          const path = [...ring.slice(from), ...ring.slice(0, from)];
          const first = path[0] ?? ref;
          issues.push({
            code: "cycle",
            ...named(first),
            path: [...path, first].map((member) => shown(member, ROOT)),
          });
        } else if (target && !state.has(ref)) {
          state.set(ref, "open");
          stack.push({ at: ref, node: target, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(frame.at, "closed");
      close(frame.at, frame.node);
    }
  }

  function close(at: string, node: Node) {
    const inCycle = cyclic.has(at);
    const { folder } = splitAddress(at);
    const deps = new Map<string, Resolved>();
    let failed = inCycle;
    for (const ref of node.refs) {
      const dep = done.get(ref);
      if (dep) {
        deps.set(ref, dep);
        continue;
      }
      failed = true;
      if (!nodes.has(ref) && !duplicated.has(ref)) {
        issues.push({ code: "missing", ...named(at), ref: shown(ref, folder) });
      }
      // A cycle member is explained by its cycle; only what merely reads one gets this.
      else if (!inCycle) issues.push({ code: "unresolved", ...named(at), ref: shown(ref, folder) });
    }
    if (failed) return;

    let length = 0;
    const out: string[] = [];
    for (const part of node.parts) {
      const text = typeof part === "string" ? part : (deps.get(part.ref)?.value ?? "");
      length += text.length;
      if (length > MAX_RESOLVED_LENGTH) {
        issues.push({ code: "too_large", ...named(at) });
        return;
      }
      out.push(text);
    }
    const { input } = node;
    const tainted = input.kind === "plain" && [...deps.values()].some((d) => d.kind !== "plain");
    done.set(at, {
      id: input.id,
      level: input.level,
      folder,
      key: input.key,
      kind: tainted ? "secret" : input.kind,
      tainted,
      value: out.join(""),
    });
  }

  return {
    variables: [...done].sort(([a], [b]) => compare(a, b)).map(([, resolved]) => resolved),
    issues,
  };
}

/** One variable as it is, or as it was: what a restore compares. */
export interface RestoreEntry {
  id: string;
  /** Absent is the root, `/`. */
  folder?: string;
  key: string;
  kind: VariableKind;
  value: string;
}

/** Where an entry or a change is: its address. A folder that cannot exist throws. */
const at = (e: { folder?: string; key: string }) => address(e.folder, e.key);
/** What a change says of its folder: nothing at the root, so a change there reads as it did before folders. */
const inFolder = (e: { folder?: string }) =>
  e.folder && e.folder !== ROOT ? { folder: e.folder } : {};

/**
 * `kind` is the one the key had back then. A `conflict` is a key that has another kind now. A
 * change has a `folder` only when the key is not at the root.
 */
export type RestoreChange<E extends RestoreEntry = RestoreEntry> =
  | { change: "update"; key: string; folder?: string; kind: VariableKind; current: E; wanted: E }
  | { change: "create"; key: string; folder?: string; kind: VariableKind; wanted: E }
  | { change: "remove"; key: string; folder?: string; kind: VariableKind; current: E }
  | { change: "conflict"; key: string; folder?: string; kind: VariableKind; current: E; wanted: E };

/**
 * What it takes to make `current` hold what `wanted` held, address by address: `update` a value that
 * differs, `create` a key that is gone, `remove` a key that was not there yet, `conflict` a key
 * whose kind differs (a kind cannot change, so it is left alone). A key that moved to another folder
 * is a `remove` where it was and a `create` where it is. Equal ones are left out, so a plan made
 * after a restore is empty. Sorted by address. Pure.
 */
export function planRestore<E extends RestoreEntry>(
  wanted: readonly E[],
  current: readonly E[],
): RestoreChange<E>[] {
  const was = new Map(wanted.map((e) => [at(e), e]));
  const is = new Map(current.map((e) => [at(e), e]));
  const changes: RestoreChange<E>[] = [];
  for (const where of new Set([...was.keys(), ...is.keys()])) {
    const w = was.get(where);
    const c = is.get(where);
    const e = w ?? c;
    if (!e) continue;
    const base = { key: e.key, ...inFolder(e) };
    if (w && c) {
      if (w.kind !== c.kind)
        changes.push({ change: "conflict", ...base, kind: w.kind, current: c, wanted: w });
      else if (w.value !== c.value) {
        changes.push({ change: "update", ...base, kind: w.kind, current: c, wanted: w });
      }
    } else if (w) changes.push({ change: "create", ...base, kind: w.kind, wanted: w });
    else if (c) changes.push({ change: "remove", ...base, kind: c.kind, current: c });
  }
  return changes.sort((a, b) => compare(at(a), at(b)));
}

/** A variable to bring in: the folder it goes to (absent is the root), the kind it is to have, and its value. */
export interface ImportEntry {
  folder?: string;
  key: string;
  kind: VariableKind;
  value: string;
  description?: string;
}

/**
 * `create` a key that is not there, `unchanged` one that holds this value already, `update` one
 * that holds another value (only with `overwrite`), `conflict` the same without it, `kind_mismatch`
 * a key held with another kind (a kind cannot change, so it is never applied). `folder` is there
 * only when the key is not at the root.
 */
export interface ImportChange<C extends RestoreEntry = RestoreEntry> {
  change: "create" | "update" | "unchanged" | "conflict" | "kind_mismatch";
  key: string;
  folder?: string;
  /** The kind it would have: the incoming one. */
  kind: VariableKind;
  incoming: ImportEntry;
  current?: C;
}

/**
 * What bringing `incoming` into a level that holds `current` does, address by address, sorted by
 * address. A repeated incoming address keeps its last entry. Run it again after applying and every
 * change is `unchanged`. Pure.
 */
export function planImport<C extends RestoreEntry>(
  incoming: readonly ImportEntry[],
  current: readonly C[],
  overwrite: boolean,
): ImportChange<C>[] {
  const is = new Map(current.map((e) => [at(e), e]));
  return [...new Map(incoming.map((e) => [at(e), e])).values()]
    .map((entry): ImportChange<C> => {
      const have = is.get(at(entry));
      const base = { key: entry.key, ...inFolder(entry), kind: entry.kind, incoming: entry };
      if (!have) return { ...base, change: "create" };
      if (have.kind !== entry.kind) return { ...base, change: "kind_mismatch", current: have };
      if (have.value === entry.value) return { ...base, change: "unchanged", current: have };
      return { ...base, change: overwrite ? "update" : "conflict", current: have };
    })
    .sort((a, b) => compare(at(a), at(b)));
}

/**
 * One step of a bulk edit, in `folder` (absent is the root; a `rename` stays in it). `set` is
 * create-or-update, with the kind the key has or else `secret`; no address may be named by two
 * steps.
 */
export type BulkOp =
  | { op: "set"; folder?: string; key: string; kind?: VariableKind; value: string }
  | { op: "rename"; folder?: string; key: string; to: string }
  | { op: "delete"; folder?: string; key: string };

/**
 * The addresses a step names, a bare key at the root: a bulk edit must not name one twice, so the
 * order of the steps never matters, and the same key in two folders is two addresses.
 */
export const bulkKeys = (op: BulkOp) =>
  (op.op === "rename" ? [op.key, op.to] : [op.key]).map((key) =>
    shown(address(op.folder, key), ROOT),
  );

/**
 * `create`, `update` and `unchanged` are a `set` (a key held with another kind is `kind_mismatch`,
 * never applied); `rename` and `delete` are applied; `missing` is a `rename` or `delete` of a key
 * the folder does not hold; `conflict` is a `rename` onto a key that is held there. `kind` is the
 * kind the key has or will have (a `set` without one keeps the kind of a held key, else `secret`),
 * null when there is none. `folder` is there only when the key is not at the root.
 */
export interface BulkChange<C extends RestoreEntry = RestoreEntry> {
  change:
    | "create"
    | "update"
    | "unchanged"
    | "kind_mismatch"
    | "rename"
    | "delete"
    | "missing"
    | "conflict";
  key: string;
  folder?: string;
  kind: VariableKind | null;
  /** The new key of a `rename`. */
  to?: string;
  op: BulkOp;
  current?: C;
}

/**
 * What the steps do to a level that holds `current`, sorted by address. Run it again after applying
 * and nothing is left to do: every `set` is `unchanged`, every `delete` is `missing`, and a
 * `rename` is `missing` too. Pure.
 */
export function planBulk<C extends RestoreEntry>(
  ops: readonly BulkOp[],
  current: readonly C[],
): BulkChange<C>[] {
  const is = new Map(current.map((e) => [at(e), e]));
  return ops
    .map((op): BulkChange<C> => {
      const have = is.get(at(op));
      const where = { key: op.key, ...inFolder(op) };
      if (op.op === "set") {
        const kind = op.kind ?? have?.kind ?? "secret";
        const [c] = planImport([{ ...where, kind, value: op.value }], current, true);
        return {
          change: c?.change ?? "create",
          ...where,
          kind,
          op,
          ...(have && { current: have }),
        };
      }
      if (!have) return { change: "missing", ...where, kind: null, op };
      if (op.op === "delete")
        return { change: "delete", ...where, kind: have.kind, op, current: have };
      const taken = is.has(address(op.folder, op.to));
      return {
        change: taken ? "conflict" : "rename",
        ...where,
        kind: have.kind,
        to: op.to,
        op,
        current: have,
      };
    })
    .sort((a, b) => compare(at(a), at(b)));
}
