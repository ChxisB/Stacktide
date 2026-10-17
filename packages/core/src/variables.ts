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

/** `$${` is a literal `${`; `${KEY}` is a reference. Nothing else is special (`$KEY`, `${KEY:-x}`). */
const TOKEN = new RegExp(String.raw`\$\$\{|\$\{(${KEY})\}`, "g");

/**
 * The longest a resolved value may be, in UTF-16 units. Checked as a value is assembled, so a
 * chain that doubles at every step stops at the limit instead of exhausting memory.
 */
export const MAX_RESOLVED_LENGTH = 1_048_576;

/** One live variable of the chain; `ChainEntry` in `@orch/db` has this shape. */
export interface VariableInput {
  id: string;
  level: VariableLevel;
  key: string;
  kind: VariableKind;
  value: string;
}

export interface Resolved {
  /** The variable that won this key. */
  id: string;
  level: VariableLevel;
  key: string;
  /** What the value must be treated as: `secret` when it was `plain` but reads a secret or a file. */
  kind: VariableKind;
  /** True when `kind` is `secret` only because of what the value references. */
  tainted: boolean;
  /** Plaintext, whatever the kind: the caller decides who may see it. */
  value: string;
}

/** Why a key has no result. Key names only, never a value. */
export type ResolveIssue =
  | { code: "missing"; key: string; ref: string }
  /** `path` starts and ends with the same key, and starts with the smallest key of the ring. */
  | { code: "cycle"; key: string; path: string[] }
  /** The key reads `ref`, which has no result itself. */
  | { code: "unresolved"; key: string; ref: string }
  /** Several variables with this key at the most specific level that has it. */
  | { code: "duplicate"; key: string; level: VariableLevel }
  | { code: "too_large"; key: string };

export interface Resolution {
  /** Sorted by key. A key with an issue is not in here. */
  variables: Resolved[];
  issues: ResolveIssue[];
}

type Part = string | { ref: string };
interface Node {
  input: VariableInput;
  parts: Part[];
  /** Distinct references, in order of first use. */
  refs: string[];
}
interface Frame {
  key: string;
  node: Node;
  next: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : Number(a > b));

function parse(value: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index > last) parts.push(value.slice(last, m.index));
    parts.push(m[1] === undefined ? "${" : { ref: m[1] });
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return parts;
}

/**
 * Turns the variables that apply to one environment (the organization's, the project's and the
 * environment's, as one list) into the set it sees. Pure.
 *
 * - The most specific level wins each key. A reference reads the winner, so `${A}` in a project
 *   variable sees an environment's `A`, and a variable that references its own key is a cycle.
 * - `${KEY}` is replaced by the resolved value of `KEY`; `$${` writes a literal `${`. Substituted
 *   text is not read again. `file` variables are taken as they are (nothing in them is a
 *   reference, and a `$${` in one stays as written) but can be referenced.
 * - A `plain` value that reads a `secret` or a `file` becomes a `secret` (`tainted`), through any
 *   depth of references.
 * - A key that cannot be resolved (missing reference, cycle, duplicate, too large, or reading a
 *   key that failed) is left out and explained in `issues`; the rest still resolves. The order of
 *   the input changes nothing.
 */
export function resolveVariables(inputs: readonly VariableInput[]): Resolution {
  const issues: ResolveIssue[] = [];

  // The most specific level that has the key; several there is a duplicate.
  const candidates = new Map<string, VariableInput[]>();
  for (const input of inputs) {
    const held = candidates.get(input.key) ?? [];
    const rank = VARIABLE_LEVELS.indexOf(input.level);
    const heldRank = VARIABLE_LEVELS.indexOf(held[0]?.level ?? input.level);
    if (!held[0] || rank > heldRank) candidates.set(input.key, [input]);
    else if (rank === heldRank) held.push(input);
  }

  const keys = [...candidates.keys()].sort(compare);
  const nodes = new Map<string, Node>();
  const duplicated = new Set<string>();
  for (const key of keys) {
    const [input, ...others] = candidates.get(key) ?? [];
    if (!input) continue;
    if (others.length > 0) {
      duplicated.add(key);
      issues.push({ code: "duplicate", key, level: input.level });
      continue;
    }
    const parts = input.kind === "file" ? [input.value] : parse(input.value);
    const refs = [...new Set(parts.flatMap((p) => (typeof p === "string" ? [] : [p.ref])))];
    nodes.set(key, { input, parts, refs });
  }

  const done = new Map<string, Resolved>();
  const state = new Map<string, "open" | "closed">();
  const cyclic = new Set<string>();

  // Depth first, with an explicit stack: a long chain must not overflow the call stack.
  for (const root of keys) {
    const rootNode = nodes.get(root);
    if (!rootNode || state.has(root)) continue;
    state.set(root, "open");
    const stack: Frame[] = [{ key: root, node: rootNode, next: 0 }];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const ref = frame.node.refs[frame.next];
      if (ref !== undefined) {
        frame.next += 1;
        const target = nodes.get(ref);
        if (state.get(ref) === "open") {
          const ring = stack.slice(stack.findIndex((f) => f.key === ref)).map((f) => f.key);
          for (const member of ring) cyclic.add(member);
          const from = ring.indexOf([...ring].sort(compare)[0] ?? ref);
          const path = [...ring.slice(from), ...ring.slice(0, from)];
          issues.push({ code: "cycle", key: path[0] ?? ref, path: [...path, path[0] ?? ref] });
        } else if (target && !state.has(ref)) {
          state.set(ref, "open");
          stack.push({ key: ref, node: target, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(frame.key, "closed");
      close(frame.key, frame.node);
    }
  }

  function close(key: string, node: Node) {
    const inCycle = cyclic.has(key);
    const deps = new Map<string, Resolved>();
    let failed = inCycle;
    for (const ref of node.refs) {
      const dep = done.get(ref);
      if (dep) {
        deps.set(ref, dep);
        continue;
      }
      failed = true;
      if (!nodes.has(ref) && !duplicated.has(ref)) issues.push({ code: "missing", key, ref });
      // A cycle member is explained by its cycle; only what merely reads one gets this.
      else if (!inCycle) issues.push({ code: "unresolved", key, ref });
    }
    if (failed) return;

    let length = 0;
    const out: string[] = [];
    for (const part of node.parts) {
      const text = typeof part === "string" ? part : (deps.get(part.ref)?.value ?? "");
      length += text.length;
      if (length > MAX_RESOLVED_LENGTH) {
        issues.push({ code: "too_large", key });
        return;
      }
      out.push(text);
    }
    const { input } = node;
    const tainted = input.kind === "plain" && [...deps.values()].some((d) => d.kind !== "plain");
    done.set(key, {
      id: input.id,
      level: input.level,
      key,
      kind: tainted ? "secret" : input.kind,
      tainted,
      value: out.join(""),
    });
  }

  return { variables: [...done.values()].sort((a, b) => compare(a.key, b.key)), issues };
}
