import { describe, expect, test } from "bun:test";
import {
  canTransition,
  isFinishedRun,
  outcomeOfJob,
  outcomeOfMissingJob,
  pathTo,
  RUN_STATES,
  type RunState,
  TRANSITIONS,
} from "./run-state";

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

describe("pathTo", () => {
  test("walks through the states an event did not show", () => {
    expect(pathTo("queued", "planned")).toEqual(["planning", "planned"]);
    expect(pathTo("planned", "applying")).toEqual(["applying"]);
    expect(pathTo("queued", "planning")).toEqual(["planning"]);
  });

  test("takes the direct way out when there is one, and is empty where it already is", () => {
    expect(pathTo("queued", "failed")).toEqual(["failed"]);
    expect(pathTo("planning", "canceled")).toEqual(["canceled"]);
    for (const s of RUN_STATES) expect(pathTo(s, s)).toEqual([]);
  });

  test("never goes through applying: that takes the apply lock, and only the target may be it", () => {
    expect(pathTo("planned", "applied")).toBeUndefined();
    expect(pathTo("planned", "failed")).toBeUndefined();
    expect(pathTo("queued", "applied")).toBeUndefined();
    expect(pathTo("queued", "applying")).toEqual(["planning", "planned", "applying"]);
    for (const [from, to] of PAIRS) {
      expect(pathTo(from, to)?.slice(0, -1) ?? [], `${from} -> ${to}`).not.toContain("applying");
    }
  });

  test("never goes back or out of a finished state", () => {
    expect(pathTo("planned", "planning")).toBeUndefined();
    expect(pathTo("planned", "canceled")).toBeUndefined();
    expect(pathTo("applying", "planned")).toBeUndefined();
    for (const from of RUN_STATES.filter(isFinishedRun)) {
      for (const to of RUN_STATES.filter((s) => s !== from)) {
        expect(pathTo(from, to), `${from} -> ${to}`).toBeUndefined();
      }
    }
  });

  test("every step it returns is a legal move, and it ends on the target", () => {
    for (const [from, to] of PAIRS) {
      const path = pathTo(from, to);
      if (path === undefined) continue;
      let at: RunState = from;
      for (const step of path) {
        expect(canTransition(at, step), `${from} -> ${to} via ${at} -> ${step}`).toBe(true);
        at = step;
      }
      expect(at).toBe(to);
    }
  });

  test("a name that is not a state has no path", () => {
    for (const bad of ["", "__proto__", "constructor", "nope"]) {
      expect(pathTo(bad, "planned")).toBeUndefined();
      expect(pathTo("queued", bad)).toBeUndefined();
    }
  });
});

describe("outcomeOfJob", () => {
  test("a plan job: running plans, success has a plan, failure and a stop end it", () => {
    expect(outcomeOfJob("plan", "running")).toEqual({ to: "planning" });
    expect(outcomeOfJob("plan", "canceling")).toEqual({ to: "planning" });
    expect(outcomeOfJob("plan", "success")).toEqual({ to: "planned" });
    expect(outcomeOfJob("plan", "failed")).toEqual({ to: "failed", error: "the plan failed" });
    expect(outcomeOfJob("plan", "canceled")).toEqual({ to: "canceled" });
    expect(outcomeOfJob("plan", "skipped")).toEqual({ to: "canceled" });
  });

  test("an apply job can only end applied or failed, and a stop is a failure", () => {
    expect(outcomeOfJob("apply", "success")).toEqual({ to: "applied" });
    expect(outcomeOfJob("apply", "failed")).toEqual({ to: "failed", error: "the apply failed" });
    expect(outcomeOfJob("apply", "canceled")).toEqual({
      to: "failed",
      error: "the apply was canceled",
    });
    expect(outcomeOfJob("apply", "skipped")).toEqual({
      to: "failed",
      error: "the apply was skipped",
    });
  });

  test("a job that has not started, or a status that is not known, says nothing", () => {
    for (const status of [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "manual",
      "scheduled",
      "unknown",
      "",
      "__proto__",
    ]) {
      expect(outcomeOfJob("plan", status), `plan ${status}`).toBeUndefined();
      expect(outcomeOfJob("apply", status), `apply ${status}`).toBeUndefined();
    }
    expect(outcomeOfJob("apply", "running")).toBeUndefined();
    expect(outcomeOfJob("apply", "canceling")).toBeUndefined();
  });

  test("every target is a state, and every error is short fixed words", () => {
    for (const action of ["plan", "apply"] as const) {
      for (const status of ["running", "canceling", "success", "failed", "canceled", "skipped"]) {
        const o = outcomeOfJob(action, status);
        if (!o) continue;
        expect(RUN_STATES).toContain(o.to);
        if (o.error !== undefined) {
          expect(isFinishedRun(o.to)).toBe(true);
          expect(o.error).toMatch(/^[a-z ]{1,60}$/);
        }
      }
    }
  });
});

describe("outcomeOfMissingJob", () => {
  test("a pipeline that ended without a job for the stack stops it", () => {
    expect(outcomeOfMissingJob("canceled")).toEqual({ to: "canceled" });
    for (const status of ["success", "failed", "skipped"]) {
      expect(outcomeOfMissingJob(status)).toEqual({
        to: "failed",
        error: "no job ran for this stack",
      });
    }
  });

  test("a pipeline that is still going, or unknown, says nothing", () => {
    for (const status of ["created", "pending", "running", "manual", "canceling", "", "nope"]) {
      expect(outcomeOfMissingJob(status), status).toBeUndefined();
    }
  });
});
