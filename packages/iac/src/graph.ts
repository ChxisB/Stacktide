/** What the graph needs of a stack: its name and the names it depends on. */
export interface DagNode {
  name: string;
  dependsOn: readonly string[];
}

export type GraphErrorKind = "duplicate-name" | "unknown-dependency" | "self-dependency" | "cycle";

export interface GraphError {
  kind: GraphErrorKind;
  /** The stacks involved: the name, the dependent and its dependency, or a cycle's path. */
  stacks: string[];
  message: string;
}

export interface Graph {
  /** Every stack name, sorted. */
  readonly names: readonly string[];
  /** What the stack depends on directly, sorted. */
  dependencies(name: string): string[];
  /**
   * Groups stacks into waves: every stack comes after all the stacks it depends on, directly or
   * through stacks that are not in `subset`, and a wave holds the stacks that may run together
   * (sorted by name). The default is every stack.
   */
  waves(subset?: Iterable<string>): string[][];
  /** The changed stacks and every stack that depends on one of them, directly or not; sorted. */
  affected(changed: Iterable<string>): string[];
}

export type Built = { ok: true; graph: Graph } | { ok: false; errors: GraphError[] };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The shortest path from `from` back to itself through `edges`, or undefined. Which of several shortest ones is found follows the sorted order of names. */
function cycleThrough(from: string, edges: Map<string, string[]>): string[] | undefined {
  const parent = new Map<string, string>();
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const d of edges.get(n) ?? []) {
        if (d === from) {
          const path = [n];
          for (let p = parent.get(n); p !== undefined; p = parent.get(p)) path.push(p);
          return [...path.reverse(), from];
        }
        if (!parent.has(d)) {
          parent.set(d, n);
          next.push(d);
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Every name reachable from `from` along `edges`, `from` included. */
function reach(from: string, edges: Map<string, string[]>) {
  const seen = new Set([from]);
  const todo = [from];
  for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
    for (const d of edges.get(n) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        todo.push(d);
      }
    }
  }
  return seen;
}

/**
 * Builds the dependency graph of a set of stacks, or says everything that is wrong with it: a name
 * used twice (only the first stack of that name is looked at further), a dependency that is not a
 * stack, a stack depending on itself, and each group of stacks that depend on one another in a
 * circle (one shortest cycle per group, as a path that ends where it starts, every stack depending
 * on the next). Nothing is built from a graph with errors.
 */
export function buildGraph(nodes: readonly DagNode[]): Built {
  const errors: GraphError[] = [];
  const deps = new Map<string, string[]>();
  const repeated = new Set<string>();
  for (const node of [...nodes].sort((a, b) => cmp(a.name, b.name))) {
    if (deps.has(node.name)) {
      if (!repeated.has(node.name)) {
        repeated.add(node.name);
        errors.push({
          kind: "duplicate-name",
          stacks: [node.name],
          message: `the name "${node.name}" is used by more than one stack`,
        });
      }
      continue;
    }
    deps.set(node.name, [...new Set(node.dependsOn)].sort(cmp));
  }
  // edges worth walking: to a stack that exists, and not to itself
  const edges = new Map<string, string[]>();
  for (const [name, list] of deps) {
    const kept: string[] = [];
    for (const d of list) {
      if (d === name) {
        errors.push({
          kind: "self-dependency",
          stacks: [name],
          message: `stack "${name}" depends on itself`,
        });
      } else if (!deps.has(d)) {
        errors.push({
          kind: "unknown-dependency",
          stacks: [name, d],
          message: `stack "${name}" depends on "${d}", which is not a stack`,
        });
      } else kept.push(d);
    }
    edges.set(name, kept);
  }
  const dependents = new Map<string, string[]>([...deps.keys()].map((n) => [n, []]));
  for (const [name, list] of edges) for (const d of list) dependents.get(d)?.push(name);

  // a group of stacks in a circle: from the smallest name not yet in one, find the shortest way
  // back to it, and count the whole group as reported
  const inCircle = new Set<string>();
  for (const name of deps.keys()) {
    if (inCircle.has(name)) continue;
    const path = cycleThrough(name, edges);
    if (!path) continue;
    // the group is what `name` reaches and is reached by
    const back = reach(name, dependents);
    for (const n of reach(name, edges)) if (back.has(n)) inCircle.add(n);
    errors.push({
      kind: "cycle",
      stacks: path,
      message: `dependency cycle: ${path.join(" -> ")} (each stack depends on the next)`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const names = [...deps.keys()];
  // the full graph in dependency order, to count chains in
  const order: string[] = [];
  const left = new Map([...edges].map(([n, list]) => [n, list.length]));
  for (let ready = names.filter((n) => left.get(n) === 0); ready.length > 0; ) {
    const next: string[] = [];
    for (const n of ready) {
      order.push(n);
      for (const d of dependents.get(n) ?? []) {
        const rest = (left.get(d) ?? 0) - 1;
        left.set(d, rest);
        if (rest === 0) next.push(d);
      }
    }
    ready = next;
  }

  const known = (name: string) => {
    if (!deps.has(name)) throw new Error(`unknown stack "${name}"`);
    return name;
  };
  const graph: Graph = {
    names,
    dependencies: (name) => [...(edges.get(known(name)) ?? [])],
    waves(subset) {
      const chosen = subset === undefined ? new Set(names) : new Set([...subset].map(known));
      // the longest run of chosen stacks that must come before this one, through any stacks
      const before = new Map<string, number>();
      const waves: string[][] = [];
      for (const n of order) {
        let k = 0;
        for (const d of edges.get(n) ?? [])
          k = Math.max(k, (before.get(d) ?? 0) + (chosen.has(d) ? 1 : 0));
        before.set(n, k);
        if (chosen.has(n)) {
          const wave = waves[k] ?? [];
          wave.push(n);
          waves[k] = wave;
        }
      }
      return waves.map((w) => w.sort(cmp));
    },
    affected(changed) {
      const out = new Set<string>();
      const todo = [...changed].map(known);
      for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
        if (out.has(n)) continue;
        out.add(n);
        todo.push(...(dependents.get(n) ?? []));
      }
      return [...out].sort(cmp);
    },
  };
  return { ok: true, graph };
}
