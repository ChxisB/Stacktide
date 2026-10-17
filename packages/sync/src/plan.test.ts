import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SyncError } from "./errors";
import { type LastApplied, type PlanItem, plan, type UnmanagedPolicy } from "./plan";
import { refId } from "./ref";
import type { ItemInput, ItemRef, RemoteItem } from "./types";

const want = (
  key: string,
  value: string,
  scope = "*",
  secret = false,
  file = false,
): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file,
});
const have = (
  key: string,
  value: string | null,
  scope = "*",
  secret = false,
  file = false,
): RemoteItem => ({
  key,
  scope,
  value,
  secret,
  file,
});
const fingerprint = (value: string) => createHmac("sha256", "test key").update(value).digest("hex");
const applied = (...entries: [ItemRef, string][]): LastApplied => {
  const m = new Map(entries.map(([ref, value]) => [refId(ref), fingerprint(value)]));
  return { fingerprint, get: (ref) => m.get(refId(ref)) };
};
const summary = (items: PlanItem[]) =>
  items.map(
    (i) => `${i.action} ${i.key}@${i.scope}${i.changed.length ? ` ${i.changed.join("+")}` : ""}`,
  );

describe("plan: what happens to an item the platform wants", () => {
  test("is created when the target does not have it, in that scope", () => {
    expect(summary(plan([want("A", "1")], []))).toEqual(["create A@*"]);
    // a key in another scope is another item
    expect(summary(plan([want("A", "1", "prod")], [have("A", "1")]))).toEqual(["create A@prod"]);
    expect(summary(plan([want("A", "1")], [have("A", "1", "prod")]))).toEqual(["create A@*"]);
  });

  test("is left alone when the value and the flag are the same", () => {
    expect(
      summary(
        plan(
          [want("A", "1"), want("B", "2", "dev", true)],
          [have("A", "1"), have("B", "2", "dev", true)],
        ),
      ),
    ).toEqual(["noop A@*", "noop B@dev"]);
  });

  test("is updated, and says what differs, when the value or the secret flag does", () => {
    expect(summary(plan([want("A", "new")], [have("A", "old")]))).toEqual(["update A@* value"]);
    expect(summary(plan([want("A", "1", "*", true)], [have("A", "1")]))).toEqual([
      "update A@* secret",
    ]);
    expect(summary(plan([want("A", "1")], [have("A", "1", "*", true)]))).toEqual([
      "update A@* secret",
    ]);
    expect(summary(plan([want("A", "new", "*", true)], [have("A", "old")]))).toEqual([
      "update A@* value+secret",
    ]);
    expect(summary(plan([want("A", "1", "*", false, true)], [have("A", "1")]))).toEqual([
      "update A@* file",
    ]);
    expect(summary(plan([want("A", "1")], [have("A", "1", "*", false, true)]))).toEqual([
      "update A@* file",
    ]);
    expect(summary(plan([want("A", "new", "*", true, true)], [have("A", "old")]))).toEqual([
      "update A@* value+secret+file",
    ]);
  });

  test("a value is compared exactly: spaces, case, lines and the empty value count", () => {
    const same = ["a b", "A B", "a b ", " a b", "a\nb", "a\r\nb", ""];
    for (const a of same) {
      for (const b of same) {
        expect(plan([want("K", a)], [have("K", b)])[0]?.action).toBe(a === b ? "noop" : "update");
      }
    }
  });
});

describe("plan: what happens to an item only the target has", () => {
  const desired = [want("A", "1")];
  const actual = [
    have("A", "1"),
    have("X", "x"),
    have("X", "x", "prod"),
    have("Y", null, "dev", true),
  ];

  test("ignore (the default) leaves it out of the plan", () => {
    expect(summary(plan(desired, actual))).toEqual(["noop A@*"]);
    expect(summary(plan(desired, actual, { unmanaged: "ignore" }))).toEqual(["noop A@*"]);
  });

  test("adopt lists it, so it can be brought in, and changes nothing", () => {
    expect(summary(plan(desired, actual, { unmanaged: "adopt" }))).toEqual([
      "noop A@*",
      "adopt X@*",
      "adopt X@prod",
      "adopt Y@dev",
    ]);
  });

  test("prune deletes it, in exactly its scope", () => {
    expect(summary(plan(desired, actual, { unmanaged: "prune" }))).toEqual([
      "noop A@*",
      "delete X@*",
      "delete X@prod",
      "delete Y@dev",
    ]);
    // wanting a key in one scope does not keep it in another
    expect(summary(plan([want("X", "x", "prod")], actual, { unmanaged: "prune" }))).toEqual([
      "delete A@*",
      "delete X@*",
      "noop X@prod",
      "delete Y@dev",
    ]);
  });

  test("a policy changes only the items nobody wants", () => {
    const wanted = [want("A", "1"), want("B", "2"), want("C", "3", "dev")];
    const target = [have("A", "1"), have("B", "other")];
    const policies: UnmanagedPolicy[] = ["ignore", "adopt", "prune"];
    for (const unmanaged of policies) {
      expect(summary(plan(wanted, target, { unmanaged }))).toEqual([
        "noop A@*",
        "update B@* value",
        "create C@dev",
      ]);
    }
  });
});

describe("plan: a target that hides its values", () => {
  const ref = { key: "A", scope: "*" };

  test("is compared with what was last applied, and is left alone when that is the same", () => {
    expect(
      summary(plan([want("A", "1")], [have("A", null)], { lastApplied: applied([ref, "1"]) })),
    ).toEqual(["noop A@*"]);
  });

  test("is updated when the wanted value is not what was last applied", () => {
    expect(
      summary(plan([want("A", "2")], [have("A", null)], { lastApplied: applied([ref, "1"]) })),
    ).toEqual(["update A@* value"]);
  });

  test("is updated when nothing was ever applied, as the value cannot be known", () => {
    expect(summary(plan([want("A", "1")], [have("A", null)], { lastApplied: applied() }))).toEqual([
      "update A@* value",
    ]);
    expect(summary(plan([want("A", "1")], [have("A", null)]))).toEqual(["update A@* value"]);
    // a record of another scope or key is not a record of this item
    expect(
      summary(
        plan([want("A", "1")], [have("A", null)], {
          lastApplied: applied([{ key: "A", scope: "prod" }, "1"]),
        }),
      ),
    ).toEqual(["update A@* value"]);
    expect(
      summary(
        plan([want("A", "1")], [have("A", null)], {
          lastApplied: applied([{ key: "B", scope: "*" }, "1"]),
        }),
      ),
    ).toEqual(["update A@* value"]);
  });

  test("still sees a different secret flag when the value matches", () => {
    expect(
      summary(
        plan([want("A", "1", "*", true)], [have("A", null)], { lastApplied: applied([ref, "1"]) }),
      ),
    ).toEqual(["update A@* secret"]);
  });

  test("a value that can be read is compared as it is: a record never hides drift", () => {
    expect(
      summary(
        plan([want("A", "1")], [have("A", "edited by hand")], { lastApplied: applied([ref, "1"]) }),
      ),
    ).toEqual(["update A@* value"]);
    expect(
      summary(plan([want("A", "1")], [have("A", "1")], { lastApplied: applied([ref, "stale"]) })),
    ).toEqual(["noop A@*"]);
  });

  test("an item of the same target may hide its value while another does not", () => {
    const items = plan(
      [want("A", "1"), want("B", "2"), want("C", "3")],
      [have("A", null), have("B", "2"), have("C", "x")],
      {
        lastApplied: applied([ref, "1"]),
      },
    );
    expect(summary(items)).toEqual(["noop A@*", "noop B@*", "update C@* value"]);
  });

  test("the record is asked about the item, not given its value", () => {
    const asked: unknown[] = [];
    plan([want("A", "VALUE-CANARY")], [have("A", null)], {
      lastApplied: {
        fingerprint,
        get: (r) => {
          asked.push(r);
          return undefined;
        },
      },
    });
    expect(asked).toEqual([{ key: "A", scope: "*" }]);
  });
});

describe("plan: which item is which", () => {
  test("a key and a scope tell items apart whatever characters they hold", () => {
    const pairs: [string, string][] = [
      ["a:b", "c"],
      ["b", "c:a"],
      ["a", 'b",c'],
      ['a",b', "c"],
    ];
    const items = plan(
      pairs.map(([key, scope]) => want(key, "1", scope)),
      pairs.map(([key, scope]) => have(key, "1", scope)),
    );
    expect(summary(items)).toEqual(['noop a@b",c', 'noop a",b@c', "noop a:b@c", "noop b@c:a"]);
  });
});

describe("plan: order", () => {
  test("is by key and then scope, by code unit, whatever order the inputs come in", () => {
    const wanted = [
      want("b", "1"),
      want("B", "1", "prod"),
      want("B", "1", "dev"),
      want("B", "1", "Z"),
      want("B", "1"),
      want("\u{1F600}", "1"),
      want("￿", "1"),
    ];
    const target = [have("zz", "1"), have("a", "1", "x"), have("a", "1", "*")];
    const expected = [
      "noop B@*",
      "noop B@Z",
      "noop B@dev",
      "noop B@prod",
      "adopt a@*",
      "adopt a@x",
      "noop b@*",
      "adopt zz@*",
      // a code unit order puts the surrogate pair (0xD83D) before 0xFFFF, a code point order does not
      "noop \u{1F600}@*",
      "noop ￿@*",
    ];
    const items = plan(wanted, [...target, ...wanted.map((w) => have(w.key, w.value, w.scope))], {
      unmanaged: "adopt",
    });
    expect(summary(items)).toEqual(expected);
    const reversed = plan(
      [...wanted].reverse(),
      [...target, ...wanted.map((w) => have(w.key, w.value, w.scope))].reverse(),
      {
        unmanaged: "adopt",
      },
    );
    expect(reversed).toEqual(items);
  });

  test("does not change what it is given", () => {
    const wanted = [want("B", "1"), want("A", "2")];
    const target = [have("B", "x"), have("A", "2")];
    const before = JSON.stringify([wanted, target]);
    plan(wanted, target, { unmanaged: "prune" });
    expect(JSON.stringify([wanted, target])).toBe(before);
  });
});

describe("plan: input that cannot be planned", () => {
  const failure = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    throw new Error("did not throw");
  };

  test("an item wanted twice is invalid, and the error names it without its value", () => {
    const e = failure(() => plan([want("A", "VALUE-CANARY"), want("A", "VALUE-CANARY-2")], []));
    expect(e).toBeInstanceOf(SyncError);
    expect((e as SyncError).kind).toBe("invalid");
    expect((e as SyncError).message).toContain("A");
    expect((e as SyncError).message).not.toContain("CANARY");
    // the same key in two scopes is two items
    expect(plan([want("A", "1"), want("A", "1", "prod")], [])).toHaveLength(2);
  });

  test("an item the target lists twice is a failure of the target", () => {
    const e = failure(() => plan([], [have("A", "VALUE-CANARY"), have("A", "VALUE-CANARY")]));
    expect(e).toBeInstanceOf(SyncError);
    expect((e as SyncError).kind).toBe("failed");
    expect((e as SyncError).message).not.toContain("CANARY");
  });
});

describe("plan: no value in a plan", () => {
  // adding a field to a plan item fails here, to be read before it is allowed
  const fields: Record<keyof PlanItem, true> = {
    key: true,
    scope: true,
    action: true,
    changed: true,
  };

  test("an item is its key, scope, action and the names of what differs, and nothing else", () => {
    const items = plan(
      [
        want("A", "VALUE-CANARY-1"),
        want("B", "VALUE-CANARY-2", "dev", true),
        want("C", "VALUE-CANARY-3"),
      ],
      [
        have("A", "VALUE-CANARY-4"),
        have("B", null, "dev"),
        have("X", "VALUE-CANARY-5"),
        have("C", "VALUE-CANARY-3"),
      ],
      { unmanaged: "prune", lastApplied: applied([{ key: "B", scope: "dev" }, "VALUE-CANARY-2"]) },
    );
    expect(items.length).toBe(4);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(Object.keys(fields).sort());
    const text = JSON.stringify(items);
    expect(text).not.toContain("CANARY");
    expect(text).not.toContain(fingerprint("VALUE-CANARY-2"));
  });
});

// A seeded property test: whatever the target holds and the platform wants, a plan is the same in any
// order, applying it converges, and it never holds a value.
describe("plan: properties", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const policies: UnmanagedPolicy[] = ["ignore", "adopt", "prune"];

  for (let seed = 1; seed <= 300; seed++) {
    test(`seed ${seed}`, () => {
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
      const shuffle = <T>(xs: T[]) =>
        xs
          .map((x) => [rand(), x] as const)
          .sort((a, b) => a[0] - b[0])
          .map(([, x]) => x);
      const keys = ["A", "B", "C", "a"];
      const scopes = ["*", "dev", "prod"];
      const hidesValues = rand() < 0.4;
      const unmanaged = pick(policies);

      const desired = new Map<string, ItemInput>();
      const remote = new Map<string, RemoteItem>();
      const record = new Map<string, string>();
      for (const key of keys) {
        for (const scope of scopes) {
          const ref = { key, scope };
          const id = refId(ref);
          const value = () => `VALUE-${Math.floor(rand() * 3)}`;
          if (rand() < 0.5)
            desired.set(id, { ...ref, value: value(), secret: rand() < 0.5, file: rand() < 0.3 });
          if (rand() < 0.5) {
            const v = value();
            remote.set(id, {
              ...ref,
              value: hidesValues ? null : v,
              secret: rand() < 0.5,
              file: rand() < 0.3,
            });
            if (rand() < 0.5) record.set(id, fingerprint(v));
          }
        }
      }
      const lastApplied: LastApplied = { fingerprint, get: (r) => record.get(refId(r)) };
      const run = (d: ItemInput[], a: RemoteItem[]) => plan(d, a, { unmanaged, lastApplied });
      const items = run([...desired.values()], [...remote.values()]);

      // the same in any order, one line per item, in order, and only the items there should be
      expect(run(shuffle([...desired.values()]), shuffle([...remote.values()]))).toEqual(items);
      expect(new Set(items.map(refId)).size).toBe(items.length);
      expect(items.map((i) => `${i.key}\u0000${i.scope}`)).toEqual(
        items.map((i) => `${i.key}\u0000${i.scope}`).sort(),
      );
      const unwanted = [...remote.keys()].filter((id) => !desired.has(id));
      expect(items.length).toBe(desired.size + (unmanaged === "ignore" ? 0 : unwanted.length));

      // what is said of a wanted item does not depend on the policy
      const others = policies.map((p) =>
        plan([...desired.values()], [...remote.values()], { unmanaged: p, lastApplied }),
      );
      const ofWanted = (xs: PlanItem[]) => xs.filter((i) => desired.has(refId(i)));
      for (const o of others) expect(ofWanted(o)).toEqual(ofWanted(items));

      // only prune deletes and only adopt adopts, and a create has no target item
      for (const i of items) {
        expect(i.action === "delete").toBe(unmanaged === "prune" && !desired.has(refId(i)));
        expect(i.action === "adopt").toBe(unmanaged === "adopt" && !desired.has(refId(i)));
        expect(i.action === "create").toBe(desired.has(refId(i)) && !remote.has(refId(i)));
        expect(i.action === "update").toBe(
          i.changed.length > 0 && desired.has(refId(i)) && remote.has(refId(i)),
        );
      }

      // no value, not even a fingerprint
      expect(JSON.stringify(items)).not.toContain("VALUE");

      // applying the plan converges: the next plan only leaves alone, adopts or lists what it was told to
      for (const i of items) {
        const id = refId(i);
        const d = desired.get(id);
        if (i.action === "delete") remote.delete(id);
        if (d && (i.action === "create" || i.action === "update")) {
          remote.set(id, {
            key: d.key,
            scope: d.scope,
            value: hidesValues ? null : d.value,
            secret: d.secret,
            file: d.file,
          });
          record.set(id, fingerprint(d.value));
        }
      }
      const next = run([...desired.values()], [...remote.values()]);
      expect(next.every((i) => i.action === "noop" || i.action === "adopt")).toBe(true);
      expect(next.filter((i) => i.action === "noop").length).toBe(desired.size);
    });
  }
});
