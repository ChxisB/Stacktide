import { describe, expect, test } from "bun:test";
import { RESOURCE_STATES, type ResourceState, resourceStateOf } from "./resource-state";
import { RUN_STATES } from "./run-state";

// for each newest run state of the stack: [the resource's state if the stack was never applied, if it was]
const TABLE: Record<string, [ResourceState, ResourceState]> = {
  queued: ["proposed", "ready"],
  planning: ["proposed", "ready"],
  planned: ["proposed", "ready"],
  discarded: ["proposed", "ready"],
  canceled: ["proposed", "ready"],
  applying: ["applying", "applying"],
  applied: ["ready", "ready"],
  failed: ["failed", "failed"],
};

describe("a resource's state, from its stack's", () => {
  test("every run state of a stack has an answer, with and without an earlier apply", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...RUN_STATES].sort());
    for (const state of RUN_STATES) {
      const [fresh, applied] = TABLE[state] as [ResourceState, ResourceState];
      expect([state, false, resourceStateOf(state, false)]).toEqual([state, false, fresh]);
      expect([state, true, resourceStateOf(state, true)]).toEqual([state, true, applied]);
    }
  });

  test("a stack no run has touched is proposed", () => {
    expect(resourceStateOf(undefined, false)).toBe("proposed");
  });

  test("a plan changes nothing in the cloud, so it does not take a live resource's state away", () => {
    for (const plan of ["queued", "planning", "planned", "discarded", "canceled"]) {
      expect(resourceStateOf(plan, true)).toBe("ready");
    }
  });

  test("a name that is not a run state is no state of its own", () => {
    for (const odd of ["", "constructor", "__proto__", "APPLIED", "applied "]) {
      expect(resourceStateOf(odd, false)).toBe("proposed");
      expect(resourceStateOf(odd, true)).toBe("ready");
    }
  });

  test("the answers are the four states the screens know", () => {
    expect([...RESOURCE_STATES]).toEqual(["proposed", "applying", "ready", "failed"]);
  });
});
