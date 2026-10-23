import { describe, expect, test } from "bun:test";
import { runOrder } from "./run-order";

const node = (name: string, ...dependsOn: string[]) => ({ name, dependsOn });
const plain = (m: ReturnType<ReturnType<typeof runOrder>>) => Object.fromEntries(m);

describe("the order of a run's stacks", () => {
  test("a chain is a column each, and a stack lists what it waits for", () => {
    const order = runOrder([node("a"), node("b", "a"), node("c", "b")]);
    expect(plain(order(["a", "b", "c"]))).toEqual({
      a: { dependsOn: [], wave: 0 },
      b: { dependsOn: ["a"], wave: 1 },
      c: { dependsOn: ["b"], wave: 2 },
    });
  });

  test("a diamond puts the two in the middle in one column", () => {
    const order = runOrder([node("a"), node("b", "a"), node("c", "a"), node("d", "b", "c")]);
    expect(plain(order(["d", "c", "b", "a"]))).toEqual({
      a: { dependsOn: [], wave: 0 },
      b: { dependsOn: ["a"], wave: 1 },
      c: { dependsOn: ["a"], wave: 1 },
      d: { dependsOn: ["b", "c"], wave: 2 },
    });
  });

  test("a stack outside the run still orders it, and the line goes to the run's stack it waits for through it", () => {
    const order = runOrder([node("a"), node("b", "a"), node("c", "b")]);
    expect(plain(order(["a", "c"]))).toEqual({
      a: { dependsOn: [], wave: 0 },
      c: { dependsOn: ["a"], wave: 1 },
    });
  });

  test("stacks that wait for nothing in the run are in the first column", () => {
    const order = runOrder([node("a"), node("b", "a"), node("c")]);
    expect(plain(order(["b", "c"]))).toEqual({
      b: { dependsOn: [], wave: 0 },
      c: { dependsOn: [], wave: 0 },
    });
  });

  test("a stack the registry no longer has has no lines and is in the first column", () => {
    const order = runOrder([node("a"), node("b", "a")]);
    expect(plain(order(["b", "gone"]))).toEqual({
      b: { dependsOn: [], wave: 0 },
      gone: { dependsOn: [], wave: 0 },
    });
  });

  test("a registry that is not a graph orders nothing, says why by kind, and does not throw", () => {
    for (const [what, nodes, kind] of [
      ["a cycle", [node("a", "b"), node("b", "a")], "cycle"],
      ["an unknown dependency", [node("a", "missing")], "unknown-dependency"],
    ] as const) {
      const seen: string[][] = [];
      const order = runOrder(nodes, (kinds) => seen.push(kinds));
      expect([what, plain(order(["a", "b"]))]).toEqual([
        what,
        { a: { dependsOn: [], wave: 0 }, b: { dependsOn: [], wave: 0 } },
      ]);
      expect([what, seen]).toEqual([what, [[kind]]]);
    }
  });
});
