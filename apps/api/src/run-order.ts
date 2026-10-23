import { buildGraph, type DagNode } from "@orch/iac";

/** What a graph of a run needs of one stack: whom it waits for, and its column. */
export interface StackOrder {
  dependsOn: string[];
  wave: number;
}
export type RunOrder = (names: readonly string[]) => Map<string, StackOrder>;

const first = { dependsOn: [], wave: 0 } satisfies StackOrder;

/**
 * The order the stacks of a run go in (FLW-1), from the project's registered stacks, which are the
 * default branch's as last scanned, not the run's commit. A stack lists the nearest stacks of the
 * run it waits for, through stacks that are not in the run; its wave counts the run's stacks that
 * must come before it. A stack the registry lacks, or a registry that is not a graph (`onError`
 * hears the kinds of what is wrong), is in the first wave with no lines: a picture that is flat is
 * better than a read that fails.
 */
export function runOrder(
  registered: readonly DagNode[],
  onError?: (kinds: string[]) => void,
): RunOrder {
  const built = buildGraph(registered);
  if (!built.ok) {
    onError?.(built.errors.map((e) => e.kind));
    return (names) => new Map(names.map((n) => [n, { ...first }]));
  }
  const { graph } = built;
  const known = new Set(graph.names);
  return (names) => {
    const inRun = new Set(names.filter((n) => known.has(n)));
    const wave = new Map<string, number>();
    graph.waves(inRun).forEach((w, i) => {
      for (const n of w) wave.set(n, i);
    });
    const nearest = (name: string) => {
      const found = new Set<string>();
      const seen = new Set<string>();
      for (const todo = graph.dependencies(name); todo.length > 0; ) {
        const d = todo.pop() as string;
        if (seen.has(d)) continue;
        seen.add(d);
        if (inRun.has(d)) found.add(d);
        else todo.push(...graph.dependencies(d));
      }
      return [...found].sort();
    };
    return new Map(
      names.map((n) => [
        n,
        inRun.has(n) ? { dependsOn: nearest(n), wave: wave.get(n) ?? 0 } : { ...first },
      ]),
    );
  };
}
