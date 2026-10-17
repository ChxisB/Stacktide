import { describe, expect, test } from "bun:test";
import { canTransition, isFinishedRun, RUN_STATES, type RunState, TRANSITIONS } from "./run-state";

// The lifecycle of one stack in a run, written out here on its own (not read back from the table):
// queued -> planning -> planned -> applying -> applied, with the ways out on the side.
const LEGAL: ReadonlyArray<readonly [RunState, RunState]> = [
  ["queued", "planning"],
  ["queued", "canceled"],
  ["queued", "failed"],
  ["planning", "planned"],
  ["planning", "failed"],
  ["planning", "canceled"],
  ["planned", "applying"],
  ["planned", "discarded"],
  ["applying", "applied"],
  ["applying", "failed"],
];
const isLegal = (from: RunState, to: RunState) => LEGAL.some(([f, t]) => f === from && t === to);
const PAIRS = RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to] as const));

describe("canTransition", () => {
  test("allows each legal move", () => {
    for (const [from, to] of LEGAL) expect(canTransition(from, to)).toBe(true);
  });

  test("rejects every other pair of states, including staying where it is", () => {
    const illegal = PAIRS.filter(([from, to]) => !isLegal(from, to));
    expect(illegal).toHaveLength(RUN_STATES.length ** 2 - LEGAL.length);
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  test("a state that is not one is never a source or a target (also names an object has)", () => {
    for (const bad of [
      "",
      "QUEUED",
      "running",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(canTransition(bad, "planning")).toBe(false);
      expect(canTransition("queued", bad)).toBe(false);
      expect(canTransition(bad, bad)).toBe(false);
    }
  });

  test("the table lists exactly the states, and nothing it lists is unknown", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...RUN_STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) {
      for (const to of targets) expect(RUN_STATES).toContain(to);
    }
  });
});

describe("the shape of the lifecycle", () => {
  test("a finished run has no way out, and every other state can still finish", () => {
    for (const s of RUN_STATES) {
      expect(isFinishedRun(s) === (TRANSITIONS[s].length === 0), s).toBe(true);
      // follow the moves: some finished state is always reachable
      const seen = new Set<RunState>([s]);
      const todo: RunState[] = [s];
      for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
        for (const to of TRANSITIONS[next]) {
          if (!seen.has(to)) {
            seen.add(to);
            todo.push(to);
          }
        }
      }
      expect([...seen].some(isFinishedRun), s).toBe(true);
    }
  });

  test("applied, failed, discarded and canceled are the end; queued is the start of every path", () => {
    expect(RUN_STATES.filter(isFinishedRun).sort()).toEqual([
      "applied",
      "canceled",
      "discarded",
      "failed",
    ]);
    // nothing moves into `queued`: a run starts there
    for (const from of RUN_STATES) expect(canTransition(from, "queued")).toBe(false);
  });

  test("only a plan that exists can be applied, and a stack never applies twice", () => {
    for (const from of RUN_STATES) {
      expect(canTransition(from, "applying")).toBe(from === "planned");
      expect(canTransition(from, "applied")).toBe(from === "applying");
    }
  });

  test("isFinishedRun is false for anything that is not a state", () => {
    expect(isFinishedRun("applied")).toBe(true);
    expect(isFinishedRun("nope")).toBe(false);
    expect(isFinishedRun("__proto__")).toBe(false);
  });
});
