import { describe, expect, test } from "bun:test";
import { type ChangedFile, changedStacks, type Watching } from "./changes";

const stack = (name: string, path: string, watch: string[] = []): Watching => ({
  name,
  path,
  watch,
});
const edit = (path: string): ChangedFile => ({ oldPath: path, newPath: path });
const rename = (oldPath: string, newPath: string): ChangedFile => ({ oldPath, newPath });

const layout = [
  stack("network", "infra/network"),
  stack("app", "infra/app"),
  stack("db", "infra/db", ["modules/rds/**", "modules/shared"]),
  stack("cache", "infra/cache", ["modules/{redis,shared}/**/*.tf"]),
];

describe("a file in a stack's directory", () => {
  const table: [string, ChangedFile[], string[]][] = [
    ["a modified file", [edit("infra/app/main.tf")], ["app"]],
    ["a deeper file", [edit("infra/app/files/a/b/policy.json")], ["app"]],
    ["the marker itself", [edit("infra/network/stack.yml")], ["network"]],
    ["a deleted file (same path twice)", [edit("infra/db/old.tf")], ["db"]],
    ["several stacks", [edit("infra/app/a.tf"), edit("infra/network/b.tf")], ["app", "network"]],
    ["the same stack twice", [edit("infra/app/a.tf"), edit("infra/app/b.tf")], ["app"]],
    ["a name that merely starts like the directory", [edit("infra/app-two/main.tf")], []],
    ["the directory's name as a file", [edit("infra/app")], []],
    ["above the stacks", [edit("infra/README.md"), edit("README.md")], []],
    ["a file outside every stack", [edit("docs/design.md"), edit(".gitlab-ci.yml")], []],
    ["no files (a merge request that changes nothing)", [], []],
  ];
  test.each(table)("%s", (_name, files, expected) => {
    expect(changedStacks(layout, files)).toEqual(expected);
  });
});

describe("renamed files count at both ends", () => {
  const table: [string, ChangedFile[], string[]][] = [
    [
      "moved out of one stack and into another",
      [rename("infra/app/a.tf", "infra/db/a.tf")],
      ["app", "db"],
    ],
    ["renamed inside one stack", [rename("infra/app/a.tf", "infra/app/b.tf")], ["app"]],
    ["moved out of a stack to nowhere", [rename("infra/app/a.tf", "archive/a.tf")], ["app"]],
    ["moved into a stack from nowhere", [rename("archive/a.tf", "infra/app/a.tf")], ["app"]],
    ["a watched module renamed", [rename("modules/rds/a.tf", "modules/rds2/a.tf")], ["db"]],
    ["a watched module renamed away", [rename("modules/rds2/a.tf", "modules/rds/a.tf")], ["db"]],
    ["neither end is in a stack", [rename("archive/a.tf", "docs/a.tf")], []],
  ];
  test.each(table)("%s", (_name, files, expected) => {
    expect(changedStacks(layout, files)).toEqual(expected);
  });
});

describe("watch patterns", () => {
  const table: [string, ChangedFile[], string[]][] = [
    ["a shared module a stack watches", [edit("modules/rds/main.tf")], ["db"]],
    ["deep in that module", [edit("modules/rds/policies/read/a.json")], ["db"]],
    ["a module nobody watches", [edit("modules/vpc/main.tf")], []],
    [
      "a pattern that is a directory name covers what is under it",
      [edit("modules/shared/a/b.txt")],
      ["db"],
    ],
    ["a pattern that is a file name covers that file", [edit("modules/shared")], ["db"]],
    [
      "a directory pattern does not cover a sibling that starts like it",
      [edit("modules/shared-old")],
      [],
    ],
    ["nor what is under that sibling", [edit("modules/shared-old/a.tf")], []],
    ["a brace pattern, either side", [edit("modules/redis/x/main.tf")], ["cache"]],
    ["a brace pattern, the other side", [edit("modules/shared/main.tf")], ["cache", "db"]],
    ["a brace pattern does not match other files", [edit("modules/redis/x/main.json")], []],
    ["a watched path inside a stack's own directory", [edit("infra/app/x.tf")], ["app"]],
  ];
  test.each(table)("%s", (_name, files, expected) => {
    expect(changedStacks(layout, files)).toEqual(expected);
  });

  test("`*` stays inside one directory, `**` crosses them", () => {
    const stacks = [stack("one", "s/one", ["lib/*.tf"]), stack("two", "s/two", ["lib/**/*.tf"])];
    expect(changedStacks(stacks, [edit("lib/a.tf")])).toEqual(["one", "two"]);
    expect(changedStacks(stacks, [edit("lib/x/a.tf")])).toEqual(["two"]);
    expect(changedStacks(stacks, [edit("lib/x/y/a.tf")])).toEqual(["two"]);
  });

  test("a pattern is relative to the repository, not to the stack", () => {
    const stacks = [stack("one", "s/one", ["lib/**"])];
    expect(changedStacks(stacks, [edit("s/one/lib/a.tf")])).toEqual(["one"]); // by its directory
    expect(
      changedStacks([stack("one", "s/one", ["lib/**"]), stack("two", "t/two")], [edit("lib/a.tf")]),
    ).toEqual(["one"]);
    expect(changedStacks(stacks, [edit("s/lib/a.tf")])).toEqual([]);
  });

  test("a dotted name or file is an ordinary path", () => {
    const stacks = [stack("one", "s/one", ["mods/.x/**", "a.b"])];
    expect(changedStacks(stacks, [edit("mods/.x/y")])).toEqual(["one"]);
    expect(changedStacks(stacks, [edit("a.b")])).toEqual(["one"]);
    expect(changedStacks(stacks, [edit("aXb")])).toEqual([]);
  });

  test("a stack that is touched by its directory does not need its patterns", () => {
    expect(changedStacks([stack("a", "a", ["nothing/**"])], [edit("a/x.tf")])).toEqual(["a"]);
  });
});

describe("nested stacks and a stack at the root", () => {
  const nested = [stack("outer", "env"), stack("inner", "env/prod"), stack("deep", "env/prod/db")];
  const table: [string, ChangedFile[], string[]][] = [
    ["a file of the outer stack", [edit("env/main.tf")], ["outer"]],
    [
      "a file of the inner stack belongs to the inner stack only",
      [edit("env/prod/main.tf")],
      ["inner"],
    ],
    ["the innermost owns its files", [edit("env/prod/db/main.tf")], ["deep"]],
    [
      "a sibling directory of a nested stack is the outer's",
      [edit("env/prod-old/main.tf")],
      ["outer"],
    ],
    [
      "each stack when each has a file",
      [edit("env/a"), edit("env/prod/b"), edit("env/prod/db/c")],
      ["deep", "inner", "outer"],
    ],
  ];
  test.each(table)("%s", (_name, files, expected) => {
    expect(changedStacks(nested, files)).toEqual(expected);
  });

  test("a stack at the root owns everything no other stack owns", () => {
    const stacks = [stack("root", "."), stack("sub", "sub")];
    expect(changedStacks(stacks, [edit("main.tf")])).toEqual(["root"]);
    expect(changedStacks(stacks, [edit("docs/a.md")])).toEqual(["root"]);
    expect(changedStacks(stacks, [edit("sub/a.tf")])).toEqual(["sub"]);
    expect(changedStacks(stacks, [edit("sub/a.tf"), edit("x")])).toEqual(["root", "sub"]);
    expect(changedStacks(stacks, [])).toEqual([]);
  });

  test("a nested stack's change does not touch the outer one, but a watch can", () => {
    const stacks = [stack("outer", "env", ["env/prod/**"]), stack("inner", "env/prod")];
    expect(changedStacks(stacks, [edit("env/prod/a.tf")])).toEqual(["inner", "outer"]);
  });
});

test("two stacks in one directory are both touched", () => {
  const stacks = [stack("one", "x"), stack("two", "x"), stack("other", "y")];
  expect(changedStacks(stacks, [edit("x/a.tf")])).toEqual(["one", "two"]);
});

describe("input is not changed and order does not matter", () => {
  test("the same answer for any order of files and stacks, and the inputs are left alone", () => {
    const files = [
      edit("infra/app/a.tf"),
      rename("x/a", "infra/db/b"),
      edit("modules/shared/z.tf"),
    ];
    const copy = structuredClone({ layout, files });
    const forward = changedStacks(layout, files);
    expect(forward).toEqual(["app", "cache", "db"]);
    expect(changedStacks([...layout].reverse(), [...files].reverse())).toEqual(forward);
    expect({ layout, files }).toEqual(copy);
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

describe("properties over random trees", () => {
  const SEGMENTS = ["a", "b", "c"];
  const randomPath = (rand: () => number, depth: number) =>
    Array.from({ length: depth }, () => SEGMENTS[Math.floor(rand() * SEGMENTS.length)]).join("/");

  function setup(seed: number) {
    const rand = random(seed);
    const dirs = new Set<string>();
    if (rand() < 0.2) dirs.add(".");
    for (let i = 0; i < 1 + rand() * 6; i++) dirs.add(randomPath(rand, 1 + Math.floor(rand() * 3)));
    const stacks = [...dirs].map((path, i) => stack(`s${i}`, path));
    const files = Array.from({ length: Math.floor(rand() * 8) }, () =>
      edit(`${randomPath(rand, 1 + Math.floor(rand() * 4))}.tf`),
    );
    return { rand, stacks, files };
  }

  // the owner of a path is the stack with the longest directory that is a prefix of it
  const oracle = (stacks: Watching[], path: string) => {
    const owners = stacks
      .filter((s) => s.path === "." || path.startsWith(`${s.path}/`))
      .sort((x, y) => (y.path === "." ? 0 : y.path.length) - (x.path === "." ? 0 : x.path.length));
    const best = owners[0];
    return best ? [best.name] : [];
  };

  test("each changed file touches exactly the stack whose directory is closest to it", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { stacks, files } = setup(seed);
      const expected = [...new Set(files.flatMap((f) => oracle(stacks, f.newPath)))].sort();
      expect(changedStacks(stacks, files), `seed ${seed}`).toEqual(expected);
    }
  });

  test("more changes never touch fewer stacks, and a rename is both of its ends", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { rand, stacks, files } = setup(seed);
      const more = [...files, edit(`${randomPath(rand, 1 + Math.floor(rand() * 4))}.tf`)];
      const before = changedStacks(stacks, files);
      const after = changedStacks(stacks, more);
      for (const name of before) expect(after, `seed ${seed}`).toContain(name);
      const from = `${randomPath(rand, 2)}.tf`;
      const to = `${randomPath(rand, 3)}.tf`;
      const both = changedStacks(stacks, [rename(from, to)]);
      const either = changedStacks(stacks, [edit(from), edit(to)]);
      expect(both, `seed ${seed}`).toEqual(either);
    }
  });
});
