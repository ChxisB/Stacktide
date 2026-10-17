import { describe, expect, test } from "bun:test";
import { SyncError } from "./errors";
import { GITLAB_VARIABLES } from "./gitlab-variables";
import { TARGET_TYPE_NAMES, TARGET_TYPES } from "./targets";

describe("target types", () => {
  test("lists the known types, each with the connection it needs", () => {
    expect(TARGET_TYPE_NAMES).toEqual([GITLAB_VARIABLES]);
    expect(TARGET_TYPES[GITLAB_VARIABLES].connection).toBe("gitlab");
  });

  test("a config is checked and stripped to its shape", () => {
    const { validate } = TARGET_TYPES[GITLAB_VARIABLES];
    expect(validate({ project: 7, protected: true })).toEqual({ project: 7, protected: true });
    expect(validate({ group: "acme/ops" })).toEqual({ group: "acme/ops" });
  });

  test("a bad config says what the shape is and never what was given", () => {
    const { validate } = TARGET_TYPES[GITLAB_VARIABLES];
    const canary = "glpat-CANARY-TOKEN-0123456789";
    for (const bad of [
      null,
      "x",
      {},
      { project: 7, token: canary },
      { project: canary, group: 1 },
    ]) {
      const e = (() => {
        try {
          return validate(bad);
        } catch (err) {
          return err;
        }
      })();
      expect(e).toBeInstanceOf(SyncError);
      expect((e as SyncError).kind).toBe("invalid_config");
      expect(String(e)).not.toContain(canary);
    }
  });
});
