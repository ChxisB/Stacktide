// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings under test are made of `${...}`
import { describe, expect, test } from "bun:test";
import {
  KEY_PATTERN,
  MAX_RESOLVED_LENGTH,
  planImport,
  planRestore,
  type ResolveIssue,
  resolveVariables,
  type VariableInput,
  type VariableKind,
  type VariableLevel,
} from "./variables";

let seq = 0;
const v = (
  level: VariableLevel,
  key: string,
  value: string,
  kind: VariableKind = "plain",
): VariableInput => {
  seq += 1;
  return { id: `id-${seq}`, level, key, kind, value };
};
const org = (key: string, value: string, kind?: VariableKind) =>
  v("organization", key, value, kind);
const proj = (key: string, value: string, kind?: VariableKind) => v("project", key, value, kind);
const env = (key: string, value: string, kind?: VariableKind) => v("environment", key, value, kind);

/** key -> value of everything that resolved. */
const values = (inputs: VariableInput[]) =>
  Object.fromEntries(resolveVariables(inputs).variables.map((r) => [r.key, r.value]));
const issues = (inputs: VariableInput[]) => resolveVariables(inputs).issues;
const one = (inputs: VariableInput[], key: string) =>
  resolveVariables(inputs).variables.find((r) => r.key === key);

describe("precedence", () => {
  test("the most specific level wins, whatever the order of the input", () => {
    const o = org("A", "org");
    const p = proj("A", "project");
    const e = env("A", "env");
    for (const order of [
      [o, p, e],
      [e, p, o],
      [p, o, e],
      [e, o, p],
    ]) {
      expect(values(order)).toEqual({ A: "env" });
    }
    expect(values([o, p])).toEqual({ A: "project" });
    expect(values([e, o])).toEqual({ A: "env" });
    expect(values([o])).toEqual({ A: "org" });
  });

  test("keys at different levels all appear, sorted by key", () => {
    const r = resolveVariables([env("B", "1"), org("C", "2"), proj("A", "3"), org("a", "4")]);
    expect(r.variables.map((x) => x.key)).toEqual(["A", "B", "C", "a"]);
    expect(r.issues).toEqual([]);
  });

  test("the list is sorted by key even when a key is resolved before the one that sorts first", () => {
    const r = resolveVariables([org("A", "${B}${C}"), org("B", "${C}"), org("C", "x")]);
    expect(r.variables.map((x) => x.key)).toEqual(["A", "B", "C"]);
  });

  test("a result says which variable and level it came from", () => {
    const o = org("A", "org");
    const e = env("A", "env");
    expect(one([o, e], "A")).toMatchObject({ id: e.id, level: "environment" });
    expect(one([o], "A")).toMatchObject({ id: o.id, level: "organization" });
  });

  test("an override replaces the kind too: a plain override of a secret is plain", () => {
    const r = one([org("A", "s", "secret"), env("A", "p")], "A");
    expect(r).toMatchObject({ kind: "plain", value: "p", tainted: false });
  });

  test("a reference sees the winner of its key, not a shadowed value", () => {
    expect(values([org("X", "1"), env("X", "2"), proj("Y", "${X}")])).toEqual({ X: "2", Y: "2" });
  });

  test("no input resolves to nothing", () => {
    expect(resolveVariables([])).toEqual({ variables: [], issues: [] });
  });

  test("keys named like Object.prototype members are ordinary keys", () => {
    const r = resolveVariables([
      org("__proto__", "a"),
      org("constructor", "b"),
      org("toString", "${constructor}"),
      org("hasOwnProperty", "${valueOf}"),
    ]);
    expect(r.variables.map((x) => [x.key, x.value])).toEqual([
      ["__proto__", "a"],
      ["constructor", "b"],
      ["toString", "b"],
    ]);
    expect(r.issues).toEqual([{ code: "missing", key: "hasOwnProperty", ref: "valueOf" }]);
  });
});

describe("interpolation", () => {
  test.each([
    ["a ${B} c", "a 1 c"],
    ["${B}", "1"],
    ["${B}${B}", "11"],
    ["${B}-${C}", "1-2"],
    ["x${B}", "x1"],
    ["${B}x", "1x"],
    ["", ""],
  ])("%j -> %j", (template, expected) => {
    expect(values([org("A", template), org("B", "1"), org("C", "2")]).A).toBe(expected);
  });

  test("references nest and chain", () => {
    expect(values([org("A", "${B}/a"), org("B", "${C}/b"), org("C", "root")])).toEqual({
      A: "root/b/a",
      B: "root/b",
      C: "root",
    });
  });

  test("references cross levels", () => {
    expect(values([env("A", "${B}:${C}"), proj("B", "p"), org("C", "o")]).A).toBe("p:o");
  });

  test.each([
    "$B",
    "$ {B}",
    "${}",
    "${1B}",
    "${B-C}",
    "${B:-x}",
    "${B",
    "{B}",
    "$",
    "${",
    "}",
    "$$",
    "${B }",
    "${ B}",
  ])("%j is not a reference: it stays as written", (template) => {
    const r = resolveVariables([org("A", template), org("B", "1")]);
    expect(r.issues).toEqual([]);
    expect(r.variables.find((x) => x.key === "A")?.value).toBe(template);
  });

  test("$${ writes a literal ${ and starts no reference", () => {
    expect(values([org("A", "$${B}"), org("B", "1")]).A).toBe("${B}");
    expect(values([org("A", "$${B}${B}"), org("B", "1")]).A).toBe("${B}1");
    expect(values([org("A", "$${")]).A).toBe("${");
    expect(values([org("A", "$$${B}"), org("B", "1")]).A).toBe("$${B}");
  });

  test("text that came out of a substitution is not read again", () => {
    const r = resolveVariables([org("A", "$${B}"), org("C", "<${A}>"), org("B", "1")]);
    expect(r.variables.find((x) => x.key === "C")?.value).toBe("<${B}>");
    expect(r.issues).toEqual([]);
    // Nor does a value that merely contains the text of a reference.
    expect(values([org("A", "${B}"), org("B", "${C}"), org("C", "x")]).A).toBe("x");
  });

  test("a reference must name a whole key: 255 characters at most", () => {
    const longest = `A${"b".repeat(254)}`;
    expect(values([org(longest, "yes"), org("R", `\${${longest}}`)]).R).toBe("yes");
    const tooLong = `${longest}b`;
    expect(values([org("R", `\${${tooLong}}`)]).R).toBe(`\${${tooLong}}`);
  });

  test("a value with no reference is returned byte for byte", () => {
    const text = "line 1\nline 2\r\n\t  trailing  é\u{1f600}";
    expect(values([org("A", text)]).A).toBe(text);
  });
});

describe("file variables", () => {
  test("are never interpolated: ${...} in a file stays as it is", () => {
    const r = resolveVariables([org("F", "key=${NOPE} $${X}", "file")]);
    expect(r.issues).toEqual([]);
    expect(r.variables[0]).toMatchObject({ key: "F", kind: "file", value: "key=${NOPE} $${X}" });
  });

  test("can be referenced: the reference becomes a secret", () => {
    const r = resolveVariables([org("F", "BEGIN\nxyz\nEND", "file"), proj("A", "cert=${F}")]);
    expect(r.variables.find((x) => x.key === "A")).toMatchObject({
      kind: "secret",
      tainted: true,
      value: "cert=BEGIN\nxyz\nEND",
    });
    expect(r.variables.find((x) => x.key === "F")).toMatchObject({ kind: "file", tainted: false });
  });
});

describe("taint", () => {
  test("a plain value that references a secret is a secret", () => {
    const r = resolveVariables([org("S", "x", "secret"), org("A", "u:${S}")]);
    expect(r.variables.find((x) => x.key === "A")).toMatchObject({ kind: "secret", tainted: true });
    expect(r.variables.find((x) => x.key === "S")).toMatchObject({
      kind: "secret",
      tainted: false,
    });
  });

  test("passes through any depth of plain references", () => {
    const r = resolveVariables([
      org("A", "${B}"),
      org("B", "${C}"),
      org("C", "${D}"),
      org("D", "x", "secret"),
      org("E", "y"),
    ]);
    for (const key of ["A", "B", "C"]) {
      expect(r.variables.find((x) => x.key === key)).toMatchObject({
        kind: "secret",
        tainted: true,
      });
    }
    expect(r.variables.find((x) => x.key === "E")).toMatchObject({ kind: "plain", tainted: false });
  });

  test("one secret among several references is enough", () => {
    const r = resolveVariables([
      org("A", "${P}${Q}${S}${R}"),
      org("P", "1"),
      org("Q", "2"),
      org("R", "3"),
      org("S", "4", "secret"),
    ]);
    expect(r.variables.find((x) => x.key === "A")).toMatchObject({ kind: "secret", tainted: true });
  });

  test("references to plain values only leave a value plain", () => {
    const r = resolveVariables([org("A", "${B}"), org("B", "${C}"), org("C", "x")]);
    expect(r.variables.map((x) => [x.kind, x.tainted])).toEqual([
      ["plain", false],
      ["plain", false],
      ["plain", false],
    ]);
  });

  test("a secret that references plain values stays a secret, and was not tainted", () => {
    expect(one([org("S", "${P}!", "secret"), org("P", "x")], "S")).toMatchObject({
      kind: "secret",
      tainted: false,
      value: "x!",
    });
  });

  test("only the winner counts: a shadowed secret taints nothing", () => {
    const r = resolveVariables([org("S", "x", "secret"), env("S", "plain"), proj("A", "${S}")]);
    expect(r.variables.find((x) => x.key === "A")).toMatchObject({ kind: "plain", tainted: false });
  });

  test("a secret that wins taints through a lower-level plain with the same key", () => {
    const r = resolveVariables([org("S", "plain"), env("S", "x", "secret"), proj("A", "${S}")]);
    expect(r.variables.find((x) => x.key === "A")).toMatchObject({ kind: "secret", tainted: true });
  });

  test("an escaped reference reads nothing, so it taints nothing", () => {
    expect(one([org("S", "x", "secret"), org("A", "$${S}")], "A")).toMatchObject({
      kind: "plain",
      value: "${S}",
    });
  });
});

describe("missing references", () => {
  test("are reported with the key and the name, and leave the key unresolved", () => {
    const r = resolveVariables([org("A", "x${NOPE}"), org("B", "ok")]);
    expect(r.issues).toEqual([{ code: "missing", key: "A", ref: "NOPE" }]);
    expect(r.variables.map((x) => x.key)).toEqual(["B"]);
  });

  test("every missing name is reported once per key", () => {
    expect(issues([org("A", "${Y}${X}${Y}")])).toEqual([
      { code: "missing", key: "A", ref: "Y" },
      { code: "missing", key: "A", ref: "X" },
    ]);
  });

  test("whatever depends on an unresolved key is unresolved, naming the one it depends on", () => {
    expect(issues([org("A", "${B}"), org("B", "${C}"), org("C", "${NOPE}")])).toEqual([
      { code: "missing", key: "C", ref: "NOPE" },
      { code: "unresolved", key: "B", ref: "C" },
      { code: "unresolved", key: "A", ref: "B" },
    ]);
  });

  test("a good reference next to a bad one does not hide the bad one", () => {
    const r = resolveVariables([org("A", "${OK}${NOPE}"), org("OK", "1")]);
    expect(r.issues).toEqual([{ code: "missing", key: "A", ref: "NOPE" }]);
    expect(r.variables.map((x) => x.key)).toEqual(["OK"]);
  });

  test("a reference to a deleted lower-level key is still missing", () => {
    // Nothing in the input: the repository leaves deleted variables out.
    expect(issues([proj("A", "${GONE}")])).toEqual([{ code: "missing", key: "A", ref: "GONE" }]);
  });
});

describe("cycles", () => {
  test("a variable that references itself", () => {
    const r = resolveVariables([org("A", "x${A}")]);
    expect(r.issues).toEqual([{ code: "cycle", key: "A", path: ["A", "A"] }]);
    expect(r.variables).toEqual([]);
  });

  test("two variables", () => {
    const r = resolveVariables([org("B", "${A}"), org("A", "${B}")]);
    expect(r.issues).toEqual([{ code: "cycle", key: "A", path: ["A", "B", "A"] }]);
    expect(r.variables).toEqual([]);
  });

  test("a longer ring, reported from its smallest key whichever way in it was entered", () => {
    const ring = [org("D", "${B}"), org("B", "${C}"), org("C", "${A}"), org("A", "${D}")];
    const expected: ResolveIssue[] = [{ code: "cycle", key: "A", path: ["A", "D", "B", "C", "A"] }];
    expect(issues(ring)).toEqual(expected);
    expect(issues([...ring].reverse())).toEqual(expected);
  });

  test("a ring entered from outside is still reported from its smallest key, and only the ring", () => {
    const r = resolveVariables([org("A", "${C}"), org("C", "${B}"), org("B", "${C}")]);
    expect(r.issues).toEqual([
      { code: "cycle", key: "B", path: ["B", "C", "B"] },
      { code: "unresolved", key: "A", ref: "C" },
    ]);
  });

  test("what leads into a cycle is unresolved, what only sits beside it still resolves", () => {
    const r = resolveVariables([
      org("A", "${B}"),
      org("B", "${A}"),
      org("TAIL", "${A}"),
      org("TAIL2", "${TAIL}"),
      org("FINE", "ok"),
    ]);
    expect(r.issues).toEqual([
      { code: "cycle", key: "A", path: ["A", "B", "A"] },
      { code: "unresolved", key: "TAIL", ref: "A" },
      { code: "unresolved", key: "TAIL2", ref: "TAIL" },
    ]);
    expect(r.variables.map((x) => x.key)).toEqual(["FINE"]);
  });

  test("a member of a cycle that also has a missing reference reports both", () => {
    expect(issues([org("A", "${B}${NOPE}"), org("B", "${A}")])).toEqual([
      { code: "cycle", key: "A", path: ["A", "B", "A"] },
      { code: "missing", key: "A", ref: "NOPE" },
    ]);
  });

  test("a cycle is of winners: an override can break it", () => {
    const base = [org("A", "${B}"), org("B", "${A}")];
    expect(issues(base).map((i) => i.code)).toEqual(["cycle"]);
    const r = resolveVariables([...base, env("B", "end")]);
    expect(r.issues).toEqual([]);
    expect(Object.fromEntries(r.variables.map((x) => [x.key, x.value]))).toEqual({
      A: "end",
      B: "end",
    });
  });

  test("a diamond is not a cycle", () => {
    const r = resolveVariables([
      org("TOP", "${L}${R}"),
      org("L", "${BOTTOM}"),
      org("R", "${BOTTOM}"),
      org("BOTTOM", "b"),
    ]);
    expect(r.issues).toEqual([]);
    expect(r.variables.find((x) => x.key === "TOP")?.value).toBe("bb");
  });
});

describe("duplicates", () => {
  test("two variables with one key at the winning level resolve to nothing", () => {
    const r = resolveVariables([proj("A", "1"), proj("A", "2"), org("A", "0"), org("B", "${A}")]);
    expect(r.issues).toEqual([
      { code: "duplicate", key: "A", level: "project" },
      { code: "unresolved", key: "B", ref: "A" },
    ]);
    expect(r.variables).toEqual([]);
  });

  test("a duplicate below the winner changes nothing", () => {
    const r = resolveVariables([org("A", "1"), org("A", "2"), env("A", "3")]);
    expect(r.issues).toEqual([]);
    expect(r.variables.map((x) => x.value)).toEqual(["3"]);
  });

  test("a more specific variable settles a duplicate above it", () => {
    expect(values([org("A", "1"), org("A", "2"), proj("A", "3")])).toEqual({ A: "3" });
  });
});

describe("size", () => {
  test("a value over the limit is refused, one at the limit is not", () => {
    expect(issues([org("A", "x".repeat(MAX_RESOLVED_LENGTH + 1))])).toEqual([
      { code: "too_large", key: "A" },
    ]);
    expect(values([org("A", "x".repeat(MAX_RESOLVED_LENGTH))]).A?.length).toBe(MAX_RESOLVED_LENGTH);
  });

  test("a reference that grows past the limit is refused, and so is what depends on it", () => {
    const half = "x".repeat(MAX_RESOLVED_LENGTH / 2);
    const r = resolveVariables([
      org("H", half),
      org("A", "${H}${H}y"),
      org("B", "${A}"),
      org("OK", "${H}${H}"),
    ]);
    expect(r.issues).toEqual([
      { code: "too_large", key: "A" },
      { code: "unresolved", key: "B", ref: "A" },
    ]);
    expect(r.variables.map((x) => x.key)).toEqual(["H", "OK"]);
  });

  test("a chain that doubles at every step stops at the limit, quickly", () => {
    const chain = [org("V0", "xx")];
    for (let i = 1; i <= 60; i++) chain.push(org(`V${i}`, `\${V${i - 1}}\${V${i - 1}}`));
    const start = performance.now();
    const r = resolveVariables(chain);
    expect(performance.now() - start).toBeLessThan(2000);
    const tooLarge = r.issues.filter((i) => i.code === "too_large");
    expect(tooLarge).toHaveLength(1);
    // V0..V19 fit (2 * 2^19 characters is the most that does), V20 is the first that does not.
    expect(tooLarge).toEqual([{ code: "too_large", key: "V20" }]);
    expect(r.issues.filter((i) => i.code === "unresolved")).toHaveLength(40);
    expect(r.variables).toHaveLength(20);
    expect(r.variables.every((x) => x.value.length <= MAX_RESOLVED_LENGTH)).toBe(true);
  });
});

describe("scale", () => {
  test("a very long chain of references does not overflow the stack", () => {
    const n = 20_000;
    const chain = [org("K0", "end")];
    for (let i = 1; i < n; i++) chain.push(org(`K${i}`, `\${K${i - 1}}`));
    const r = resolveVariables(chain.reverse());
    expect(r.issues).toEqual([]);
    expect(r.variables).toHaveLength(n);
    expect(r.variables.every((x) => x.value === "end")).toBe(true);
  });

  test("a very long ring is one cycle", () => {
    const n = 20_000;
    const ring: VariableInput[] = [];
    for (let i = 0; i < n; i++) ring.push(org(`R${i}`, `\${R${(i + 1) % n}}`));
    const r = resolveVariables(ring);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: "cycle" });
    expect((r.issues[0] as { path: string[] }).path).toHaveLength(n + 1);
  });
});

describe("what issues may carry", () => {
  test("key names and paths only, never a value", () => {
    const marker = "S3CR3T-MARKER";
    const r = resolveVariables([
      org("A", `${marker}\${NOPE}`, "secret"),
      org("B", `${marker}\${C}`),
      org("C", `${marker}\${B}`, "secret"),
      org("D", `${marker}\${A}`),
      proj("E", marker),
      proj("E", `${marker}2`),
      org("BIG", marker.repeat(MAX_RESOLVED_LENGTH)),
    ]);
    expect(r.issues.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(r.issues)).not.toContain(marker);
  });
});

describe("KEY_PATTERN", () => {
  test.each(["A", "_", "a1", "_1_", "FOO_BAR", "A".repeat(255)])("accepts %j", (k) => {
    expect(KEY_PATTERN.test(k)).toBe(true);
  });
  test.each(["", "1A", "A-B", "A B", "A.B", "A\n", "\nA", "é", "A".repeat(256), "${A}"])(
    "rejects %j",
    (k) => {
      expect(KEY_PATTERN.test(k)).toBe(false);
    },
  );
});

// ---- property tests -------------------------------------------------------------------------
// An independent reading of the rules: substitute by regex on the spot, following the path taken
// so far to find cycles. No memo, no graph, no ordering: only workable on small inputs.

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const LEVELS: VariableLevel[] = ["organization", "project", "environment"];
const KINDS: VariableKind[] = ["plain", "plain", "plain", "secret", "file"];
const KEYS = ["A", "B", "C", "D", "E", "F"];
const PIECES = ["x", "-", " ", "$", "$$", "${", "$${", "}", "${1}", "${a b}", "$A"];

interface Expected {
  value: string;
  kind: VariableKind;
}

function oracle(inputs: VariableInput[]): Map<string, Expected> {
  const rank = (l: VariableLevel) => LEVELS.indexOf(l);
  const winner = (key: string) => {
    const mine = inputs.filter((i) => i.key === key);
    const top = Math.max(...mine.map((i) => rank(i.level)));
    const at = mine.filter((i) => rank(i.level) === top);
    return at.length === 1 ? at[0] : undefined;
  };
  const open = (key: string, trail: string[]): Expected | undefined => {
    const w = winner(key);
    if (!w || trail.includes(key)) return undefined;
    if (w.kind === "file") return { value: w.value, kind: "file" };
    let kind = w.kind;
    let ok = true;
    const value = w.value.replace(/\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name?: string) => {
      if (name === undefined) return "${";
      const dep = open(name, [...trail, key]);
      if (!dep) {
        ok = false;
        return "";
      }
      if (kind === "plain" && dep.kind !== "plain") kind = "secret";
      return dep.value;
    });
    return ok ? { value, kind } : undefined;
  };
  const out = new Map<string, Expected>();
  for (const key of new Set(inputs.map((i) => i.key))) {
    const e = open(key, []);
    if (e) out.set(key, e);
  }
  return out;
}

function generate(rand: () => number): VariableInput[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const inputs: VariableInput[] = [];
  for (const level of LEVELS) {
    for (const key of KEYS) {
      if (rand() < 0.45) continue;
      let value = "";
      for (let n = Math.floor(rand() * 5); n > 0; n--) {
        // Mostly references, to make chains, cycles and taint likely; "G" is never defined.
        value += rand() < 0.6 ? `\${${pick([...KEYS, "G"])}}` : pick(PIECES);
      }
      inputs.push(v(level, key, value, pick(KINDS)));
    }
  }
  return inputs;
}

const shuffle = <T>(xs: T[], rand: () => number) => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe("properties (seeded, 1500 random chains)", () => {
  const rand = mulberry32(20261017);
  const cases = Array.from({ length: 1500 }, () => generate(rand));

  test("agrees with an independent reading of the rules", () => {
    for (const inputs of cases) {
      const want = oracle(inputs);
      const got = resolveVariables(inputs);
      expect(new Map(got.variables.map((r) => [r.key, { value: r.value, kind: r.kind }]))).toEqual(
        want,
      );
    }
  });

  test("a key is resolved, or named by an issue (or a cycle path), never both", () => {
    for (const inputs of cases) {
      const { variables, issues: found } = resolveVariables(inputs);
      const resolved = new Set(variables.map((r) => r.key));
      const named = new Set(found.flatMap((i) => (i.code === "cycle" ? i.path : [i.key])));
      for (const key of new Set(inputs.map((i) => i.key))) {
        expect(resolved.has(key)).toBe(!named.has(key));
      }
    }
  });

  test("the result does not depend on the order of the input", () => {
    for (const inputs of cases.slice(0, 500)) {
      const want = resolveVariables(inputs);
      expect(resolveVariables(shuffle(inputs, rand))).toEqual(want);
    }
  });

  test("a tainted result is a secret that was plain, and a secret never loses its kind", () => {
    for (const inputs of cases) {
      const declared = new Map<string, VariableInput>();
      for (const i of inputs) {
        const cur = declared.get(i.key);
        if (!cur || LEVELS.indexOf(i.level) >= LEVELS.indexOf(cur.level)) declared.set(i.key, i);
      }
      for (const r of resolveVariables(inputs).variables) {
        const was = declared.get(r.key)?.kind;
        expect(r.tainted).toBe(was === "plain" && r.kind === "secret");
        if (was !== "plain") expect(r.kind).toBe(was as VariableKind);
      }
    }
  });

  test("issues only name keys the input has, and carry no value", () => {
    for (const inputs of cases.slice(0, 300)) {
      const names = new Set(inputs.map((i) => i.key));
      for (const issue of resolveVariables(inputs).issues as ResolveIssue[]) {
        expect(names.has(issue.key)).toBe(true);
        expect(
          Object.keys(issue).every((k) => ["code", "key", "ref", "path", "level"].includes(k)),
        ).toBe(true);
      }
    }
  });
});

describe("planRestore", () => {
  const e = (
    key: string,
    value: string,
    kind: VariableKind = "plain",
    id = `id-${key}-${value}`,
  ) => ({
    id,
    key,
    kind,
    value,
  });
  const brief = (wanted: ReturnType<typeof e>[], current: ReturnType<typeof e>[]) =>
    planRestore(wanted, current).map((c) => `${c.change} ${c.key} ${c.kind}`);

  test("says what each key needs, sorted by key, and nothing for what is equal", () => {
    expect(
      brief(
        [e("SAME", "1"), e("CHANGED", "old"), e("GONE", "g", "secret"), e("B_KIND", "x", "secret")],
        [e("SAME", "1"), e("CHANGED", "new"), e("ADDED", "a", "file"), e("B_KIND", "x", "plain")],
      ),
    ).toEqual(
      [
        "remove ADDED file",
        "conflict B_KIND secret",
        "update CHANGED plain",
        "create GONE secret",
      ].sort((a, b) => (a.split(" ")[1] ?? "").localeCompare(b.split(" ")[1] ?? "")),
    );
  });

  test("an update carries both entries, a create the old one, a remove the current one", () => {
    const [update, create, remove] = planRestore(
      [e("A", "old"), e("B", "b")],
      [e("A", "new"), e("C", "c")],
    );
    expect(update).toMatchObject({
      change: "update",
      current: { value: "new" },
      wanted: { value: "old" },
    });
    expect(create).toMatchObject({ change: "create", wanted: { value: "b" } });
    expect(remove).toMatchObject({ change: "remove", current: { value: "c" } });
    expect(create).not.toHaveProperty("current");
    expect(remove).not.toHaveProperty("then");
  });

  test("a restore leaves nothing to restore: same values, same kinds, in any order", () => {
    const set = [e("A", "1"), e("B", "2", "secret"), e("C", "3", "file")];
    expect(planRestore(set, [...set].reverse())).toEqual([]);
    expect(planRestore([], [])).toEqual([]);
    expect(brief([], set)).toEqual(["remove A plain", "remove B secret", "remove C file"]);
    expect(brief(set, [])).toEqual(["create A plain", "create B secret", "create C file"]);
  });

  test("a value equal in text but not in kind is a conflict, and kinds are compared before values", () => {
    expect(brief([e("K", "same", "secret")], [e("K", "same", "plain")])).toEqual([
      "conflict K secret",
    ]);
    expect(brief([e("K", "a", "secret")], [e("K", "b", "plain")])).toEqual(["conflict K secret"]);
  });
});

describe("planImport", () => {
  const have = (key: string, value: string, kind: VariableKind = "secret") => ({
    id: `id-${key}`,
    key,
    kind,
    value,
  });
  const inc = (key: string, value: string, kind: VariableKind = "secret") => ({ key, kind, value });
  const brief = (
    incoming: ReturnType<typeof inc>[],
    current: ReturnType<typeof have>[],
    overwrite = false,
  ) => planImport(incoming, current, overwrite).map((c) => `${c.change} ${c.key} ${c.kind}`);

  test("says what each key is, sorted by key, and leaves the rest of the level alone", () => {
    const current = [
      have("SAME", "1"),
      have("DIFF", "old"),
      have("KIND", "x", "plain"),
      have("OTHER", "o"),
    ];
    const incoming = [inc("NEW", "n"), inc("SAME", "1"), inc("DIFF", "new"), inc("KIND", "x")];
    expect(brief(incoming, current)).toEqual([
      "conflict DIFF secret",
      "kind_mismatch KIND secret",
      "create NEW secret",
      "unchanged SAME secret",
    ]);
  });

  test("overwrite turns a differing value into an update, and nothing else", () => {
    const current = [have("DIFF", "old"), have("KIND", "x", "plain"), have("SAME", "1")];
    const incoming = [inc("DIFF", "new"), inc("KIND", "x"), inc("SAME", "1"), inc("NEW", "n")];
    expect(brief(incoming, current, true)).toEqual([
      "update DIFF secret",
      "kind_mismatch KIND secret",
      "create NEW secret",
      "unchanged SAME secret",
    ]);
  });

  test("a change carries what applying it needs", () => {
    const [c] = planImport([inc("A", "new")], [have("A", "old")], true);
    expect(c).toMatchObject({ incoming: { value: "new" }, current: { id: "id-A", value: "old" } });
    expect(planImport([inc("A", "x")], [], false)[0]).not.toHaveProperty("current");
  });

  test("a value is equal only when kind and text are, down to the last character", () => {
    expect(brief([inc("A", "x ")], [have("A", "x")])).toEqual(["conflict A secret"]);
    expect(brief([inc("A", "")], [have("A", "")])).toEqual(["unchanged A secret"]);
    expect(brief([inc("A", "a")], [have("A", "A")])).toEqual(["conflict A secret"]);
  });

  test("a repeated incoming key counts once, with its last entry", () => {
    expect(
      planImport([inc("A", "1"), inc("A", "2")], [have("A", "2")], false).map((c) => c.change),
    ).toEqual(["unchanged"]);
  });

  test("applied, the same import changes nothing", () => {
    const incoming = [inc("A", "1"), inc("B", "2")];
    const after = planImport(incoming, [], false).map((c) => have(c.key, c.incoming.value));
    expect(planImport(incoming, after, false).map((c) => c.change)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });
});
