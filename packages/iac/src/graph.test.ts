import { describe, expect, test } from "bun:test";
import { buildGraph, type DagNode, type Graph, type GraphError } from "./graph";

const nodes = (spec: Record<string, string[]>): DagNode[] =>
  Object.entries(spec).map(([name, dependsOn]) => ({ name, dependsOn }));

const graphOf = (spec: Record<string, string[]>): Graph => {
  const built = buildGraph(nodes(spec));
  if (!built.ok) throw new Error(built.errors.map((e) => e.message).join("; "));
  return built.graph;
};
const errorsOf = (spec: Record<string, string[]> | DagNode[]): GraphError[] => {
  const built = buildGraph(Array.isArray(spec) ? spec : nodes(spec));
  if (built.ok) throw new Error("expected errors");
  return built.errors;
};

describe("waves", () => {
  const table: [string, Record<string, string[]>, string[][]][] = [
    ["no stacks", {}, []],
    ["one stack", { a: [] }, [["a"]]],
    ["independent stacks run together, sorted", { c: [], a: [], b: [] }, [["a", "b", "c"]]],
    ["a chain is one stack per wave", { c: ["b"], b: ["a"], a: [] }, [["a"], ["b"], ["c"]]],
    [
      "a diamond",
      { top: ["left", "right"], left: ["base"], right: ["base"], base: [] },
      [["base"], ["left", "right"], ["top"]],
    ],
    [
      "a stack waits for its longest chain, not its shortest",
      { a: [], b: ["a"], c: ["b"], d: ["a", "c"] },
      [["a"], ["b"], ["c"], ["d"]],
    ],
    ["the same dependency listed twice", { a: [], b: ["a", "a"] }, [["a"], ["b"]]],
    [
      "separate chains share waves",
      { a1: [], a2: ["a1"], b1: [], b2: ["b1"] },
      [
        ["a1", "b1"],
        ["a2", "b2"],
      ],
    ],
  ];
  test.each(table)("%s", (_name, spec, expected) => {
    expect(graphOf(spec).waves()).toEqual(expected);
  });

  const chain = { c: ["b"], b: ["a"], a: [] };
  const subsets: [string, string[], string[][]][] = [
    ["a subset that skips a stack keeps the order through it", ["a", "c"], [["a"], ["c"]]],
    ["the end of the chain", ["b", "c"], [["b"], ["c"]]],
    ["one stack alone", ["c"], [["c"]]],
    ["nothing", [], []],
    ["a name listed twice", ["a", "a"], [["a"]]],
  ];
  test.each(subsets)("subset: %s", (_name, subset, expected) => {
    expect(graphOf(chain).waves(subset)).toEqual(expected);
  });

  test("a subset naming a stack that does not exist is refused", () => {
    expect(() => graphOf(chain).waves(["a", "nope"])).toThrow('unknown stack "nope"');
  });
});

describe("affected", () => {
  const spec = { base: [], mid: ["base"], top: ["mid"], side: ["base"], other: [] };
  const table: [string, string[], string[]][] = [
    ["a leaf changes only itself", ["top"], ["top"]],
    ["the base reaches everything that depends on it", ["base"], ["base", "mid", "side", "top"]],
    ["the middle reaches what is above it", ["mid"], ["mid", "top"]],
    ["unrelated stacks stay out", ["other"], ["other"]],
    ["several changes join up", ["side", "other"], ["other", "side"]],
    ["a name twice", ["mid", "mid"], ["mid", "top"]],
    ["nothing changed", [], []],
  ];
  test.each(table)("%s", (_name, changed, expected) => {
    expect(graphOf(spec).affected(changed)).toEqual(expected);
  });

  test("a stack that does not exist is refused", () => {
    expect(() => graphOf(spec).affected(["nope"])).toThrow('unknown stack "nope"');
  });
});

describe("dependencies and names", () => {
  test("names and direct dependencies come back sorted and without repeats", () => {
    const g = graphOf({ b: ["z", "a", "z"], z: [], a: [] });
    expect(g.names).toEqual(["a", "b", "z"]);
    expect(g.dependencies("b")).toEqual(["a", "z"]);
    expect(g.dependencies("a")).toEqual([]);
    expect(() => g.dependencies("nope")).toThrow('unknown stack "nope"');
  });

  test("the graph is a snapshot: neither the input nor what it returns changes it", () => {
    const b: DagNode = { name: "b", dependsOn: ["a"] };
    const input: DagNode[] = [{ name: "a", dependsOn: [] }, b];
    const built = buildGraph(input);
    if (!built.ok) throw new Error("expected a graph");
    const g = built.graph;
    (b.dependsOn as string[]).push("nope");
    input.pop();
    expect(g.dependencies("b")).toEqual(["a"]);
    expect(g.names).toEqual(["a", "b"]);
    g.dependencies("b").push("x");
    g.waves().pop();
    g.affected(["a"]).pop();
    expect(g.dependencies("b")).toEqual(["a"]);
    expect(g.waves()).toEqual([["a"], ["b"]]);
    expect(g.affected(["a"])).toEqual(["a", "b"]);
  });
});

describe("errors", () => {
  test("a dependency that is not a stack names both", () => {
    expect(errorsOf({ a: ["ghost"] })).toEqual([
      {
        kind: "unknown-dependency",
        stacks: ["a", "ghost"],
        message: 'stack "a" depends on "ghost", which is not a stack',
      },
    ]);
  });

  test("a stack that depends on itself", () => {
    expect(errorsOf({ a: ["a"] })).toEqual([
      { kind: "self-dependency", stacks: ["a"], message: 'stack "a" depends on itself' },
    ]);
  });

  test("a name used twice is reported once, however many times it is used", () => {
    const errors = errorsOf([
      { name: "a", dependsOn: [] },
      { name: "a", dependsOn: [] },
      { name: "a", dependsOn: [] },
      { name: "b", dependsOn: [] },
    ]);
    expect(errors).toEqual([
      {
        kind: "duplicate-name",
        stacks: ["a"],
        message: 'the name "a" is used by more than one stack',
      },
    ]);
  });

  test("a two-stack cycle reads as a closed path", () => {
    expect(errorsOf({ a: ["b"], b: ["a"] })).toEqual([
      {
        kind: "cycle",
        stacks: ["a", "b", "a"],
        message: "dependency cycle: a -> b -> a (each stack depends on the next)",
      },
    ]);
  });

  test("a longer cycle, found from its smallest name", () => {
    const [e, ...rest] = errorsOf({ c: ["a"], b: ["c"], a: ["b"] });
    expect(rest).toEqual([]);
    expect(e?.stacks).toEqual(["a", "b", "c", "a"]);
  });

  test("stacks that only lead into a cycle or hang off it are not part of it", () => {
    const errors = errorsOf({ a: ["b"], b: ["a"], above: ["a"], below: [] });
    expect(errors.map((e) => e.stacks)).toEqual([["a", "b", "a"]]);
  });

  test("the shortest way round is reported when stacks are tangled", () => {
    // a -> b -> c -> a, plus a -> c -> a directly
    const [e, ...rest] = errorsOf({ a: ["b", "c"], b: ["c"], c: ["a"] });
    expect(rest).toEqual([]);
    expect(e?.stacks).toEqual(["a", "c", "a"]);
  });

  test("separate cycles are reported separately", () => {
    const errors = errorsOf({ a: ["b"], b: ["a"], x: ["y"], y: ["z"], z: ["x"] });
    expect(errors.map((e) => e.stacks)).toEqual([
      ["a", "b", "a"],
      ["x", "y", "z", "x"],
    ]);
  });

  test("every kind of problem is reported together, and nothing is built", () => {
    const errors = errorsOf({ a: ["a", "ghost"], b: ["c"], c: ["b"] });
    expect(errors.map((e) => e.kind).sort()).toEqual([
      "cycle",
      "self-dependency",
      "unknown-dependency",
    ]);
  });
});

// A small seeded generator, so a failing case can be replayed from its seed.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Spec = Record<string, string[]>;

/** names are shuffled so that sorted order is not dependency order */
function randomNames(rand: () => number, n: number) {
  const names = Array.from({ length: n }, (_, i) => `s${i}`);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [names[i], names[j]] = [names[j] as string, names[i] as string];
  }
  return names;
}

/** each stack depends on a random selection of the ones before it, so there is no cycle */
function randomDag(rand: () => number): Spec {
  const names = randomNames(rand, Math.floor(rand() * 14));
  const density = rand();
  const spec: Spec = {};
  names.forEach((name, i) => {
    spec[name] = names.slice(0, i).filter(() => rand() < density * 0.5);
  });
  return spec;
}

/** which names each name reaches by one or more dependencies (a search from each name, so cycles are fine) */
function closure(spec: Spec) {
  const reaches = new Map<string, Set<string>>();
  for (const name of Object.keys(spec)) {
    const out = new Set<string>();
    const todo = [...(spec[name] ?? [])];
    for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
      if (out.has(n)) continue;
      out.add(n);
      todo.push(...(spec[n] ?? []));
    }
    reaches.set(name, out);
  }
  return reaches;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const pick = <T>(rand: () => number, items: T[]) => items.filter(() => rand() < 0.5);

describe("properties of random DAGs", () => {
  test("waves put every stack after everything it depends on, as early as that allows", () => {
    for (const seed of SEEDS) {
      const spec = randomDag(random(seed));
      const g = graphOf(spec);
      const waves = g.waves();
      const at = new Map(waves.flatMap((w, i) => w.map((n) => [n, i] as const)));
      // a partition of all the stacks
      expect([...at.keys()].sort(), `seed ${seed}`).toEqual(Object.keys(spec).sort());
      expect(waves.flat().length, `seed ${seed}`).toBe(Object.keys(spec).length);
      for (const w of waves) {
        expect(w.length, `seed ${seed}`).toBeGreaterThan(0);
        expect(w, `seed ${seed}`).toEqual([...w].sort());
      }
      for (const [name, deps] of Object.entries(spec)) {
        const mine = at.get(name) as number;
        for (const d of deps)
          expect(at.get(d) as number, `seed ${seed} ${name}`).toBeLessThan(mine);
        // as early as possible: one past the latest dependency
        const expected =
          deps.length === 0 ? 0 : Math.max(...deps.map((d) => at.get(d) as number)) + 1;
        expect(mine, `seed ${seed} ${name}`).toBe(expected);
      }
    }
  });

  test("waves of a subset follow the order the whole graph implies, through stacks left out", () => {
    for (const seed of SEEDS) {
      const rand = random(seed);
      const spec = randomDag(rand);
      const names = Object.keys(spec);
      const subset = pick(rand, names);
      const g = graphOf(spec);
      const waves = g.waves(subset);
      const reaches = closure(spec);
      const chosen = new Set(subset);
      // oracle: a stack's wave is the longest run of chosen stacks it must come after
      const level = new Map<string, number>();
      const levelOf = (n: string): number => {
        const known = level.get(n);
        if (known !== undefined) return known;
        const below = [...(reaches.get(n) ?? [])].filter((m) => chosen.has(m));
        const v = below.length === 0 ? 0 : Math.max(...below.map(levelOf)) + 1;
        level.set(n, v);
        return v;
      };
      const expected: string[][] = [];
      for (const n of [...chosen].sort()) {
        const wave = expected[levelOf(n)] ?? [];
        wave.push(n);
        expected[levelOf(n)] = wave;
      }
      expect(waves, `seed ${seed}`).toEqual(expected);
    }
  });

  test("affected is the change and everything that reaches it", () => {
    for (const seed of SEEDS) {
      const rand = random(seed);
      const spec = randomDag(rand);
      const names = Object.keys(spec);
      const changed = pick(rand, names);
      const g = graphOf(spec);
      const reaches = closure(spec);
      const expected = names
        .filter((n) => changed.includes(n) || changed.some((c) => reaches.get(n)?.has(c)))
        .sort();
      const got = g.affected(changed);
      expect(got, `seed ${seed}`).toEqual(expected);
      // closed: adding the affected stacks to the change adds nothing
      expect(g.affected(got), `seed ${seed}`).toEqual(got);
      // never fewer than the change
      for (const c of changed) expect(got).toContain(c);
    }
  });
});

describe("properties of random graphs that may have cycles", () => {
  test("a graph is refused exactly when it has a cycle, and each tangle is reported once as a real cycle", () => {
    let cyclic = 0;
    for (const seed of SEEDS) {
      const rand = random(seed);
      const names = randomNames(rand, 2 + Math.floor(rand() * 7));
      const density = rand() * 0.45;
      const spec: Spec = {};
      for (const n of names) spec[n] = names.filter((m) => m !== n && rand() < density);
      const reaches = closure(spec);
      // the groups of stacks that depend on each other, in a circle
      const groupOf = (n: string) =>
        names
          .filter((m) => m === n || (reaches.get(n)?.has(m) && reaches.get(m)?.has(n)))
          .sort()
          .join(",");
      const groups = new Set(names.filter((n) => reaches.get(n)?.has(n)).map(groupOf));
      const built = buildGraph(nodes(spec));
      if (groups.size === 0) {
        expect(built.ok, `seed ${seed}`).toBe(true);
        continue;
      }
      cyclic++;
      expect(built.ok, `seed ${seed}`).toBe(false);
      if (built.ok) continue;
      expect(built.errors.every((e) => e.kind === "cycle")).toBe(true);
      expect(built.errors.length, `seed ${seed}`).toBe(groups.size);
      const covered = new Set<string>();
      for (const e of built.errors) {
        const path = e.stacks;
        expect(path.length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
        expect(path[0], `seed ${seed}`).toBe(path.at(-1));
        // simple: no stack twice but the first
        expect(new Set(path.slice(1)).size, `seed ${seed}`).toBe(path.length - 1);
        // each stack depends on the next
        for (let i = 0; i + 1 < path.length; i++) {
          expect(spec[path[i] as string], `seed ${seed}`).toContain(path[i + 1] as string);
        }
        // all in one group, and each group once
        const group = groupOf(path[0] as string);
        expect(groups.has(group), `seed ${seed}`).toBe(true);
        expect(covered.has(group), `seed ${seed}`).toBe(false);
        covered.add(group);
      }
    }
    // the generator must really produce cycles, or this proves nothing
    expect(cyclic).toBeGreaterThan(50);
  });

  test("adding a dependency from a stack to something that depends on it makes a cycle through both", () => {
    let tried = 0;
    for (const seed of SEEDS) {
      const rand = random(seed);
      const spec = randomDag(rand);
      const reaches = closure(spec);
      const pairs = Object.keys(spec).flatMap((x) =>
        [...(reaches.get(x) ?? [])].map((y) => [x, y] as const),
      );
      if (pairs.length === 0) continue;
      tried++;
      const [x, y] = pairs[Math.floor(rand() * pairs.length)] as readonly [string, string];
      // x reaches y, so y depending on x closes a circle
      const broken: Spec = { ...spec, [y]: [...(spec[y] ?? []), x] };
      const errors = errorsOf(broken);
      const cycle = errors.find(
        (e) => e.kind === "cycle" && e.stacks.includes(x) && e.stacks.includes(y),
      );
      expect(cycle, `seed ${seed}`).toBeDefined();
    }
    expect(tried).toBeGreaterThan(100);
  });
});
