import { describe, expect, test } from "bun:test";
import { AWS_SM } from "./aws-sm";
import { AWS_SSM } from "./aws-ssm";
import { SyncError } from "./errors";
import { GITHUB_ACTIONS } from "./github-actions";
import { GITLAB_VARIABLES } from "./gitlab-variables";
import { KUBERNETES_SECRET } from "./kubernetes-secret";
import { isProtected, TARGET_TYPE_NAMES, TARGET_TYPES } from "./targets";
import { VAULT_KV } from "./vault-kv";

describe("target types", () => {
  test("lists the known types, each with the connection it needs", () => {
    expect(TARGET_TYPE_NAMES).toEqual([
      GITLAB_VARIABLES,
      AWS_SSM,
      AWS_SM,
      KUBERNETES_SECRET,
      VAULT_KV,
      GITHUB_ACTIONS,
    ]);
    expect(TARGET_TYPES[GITLAB_VARIABLES].connection).toBe("gitlab");
    expect(TARGET_TYPES[AWS_SSM].connection).toBe("aws_assume_role");
    expect(TARGET_TYPES[AWS_SM].connection).toBe("aws_assume_role");
    expect(TARGET_TYPES[KUBERNETES_SECRET].connection).toBe("kubernetes");
    expect(TARGET_TYPES[VAULT_KV].connection).toBe("vault_approle");
    expect(TARGET_TYPES[GITHUB_ACTIONS].connection).toBe("github");
  });

  test("a target is protected only when its config says so with a boolean true", () => {
    expect(isProtected({ project: 7, protected: true })).toBe(true);
    expect(isProtected({ region: "eu-west-1", prefix: "/a/b", protected: true })).toBe(true);
    expect(isProtected({ region: "eu-west-1", prefix: "/a/b", layout: "per-scope" })).toBe(false);
    expect(isProtected({ namespace: "apps", name: "env", protected: true })).toBe(true);
    expect(isProtected({ path: "web", protected: true })).toBe(true);
    expect(isProtected({ repository: "acme/svc", protected: true })).toBe(true);
    for (const config of [
      {},
      { protected: false },
      { protected: "true" },
      { protected: 1 },
      null,
      "x",
      undefined,
    ]) {
      expect(isProtected(config)).toBe(false);
    }
  });

  test("a config is checked and stripped to its shape", () => {
    const { validate } = TARGET_TYPES[GITLAB_VARIABLES];
    expect(validate({ project: 7, protected: true })).toEqual({ project: 7, protected: true });
    expect(validate({ group: "acme/ops" })).toEqual({ group: "acme/ops" });
  });

  test("a GitHub Actions config is checked without a client", () => {
    const { validate } = TARGET_TYPES[GITHUB_ACTIONS];
    expect(validate({ repository: "acme/svc", environment: "prod" })).toEqual({
      repository: "acme/svc",
      environment: "prod",
    });
    expect(() => validate({ repository: "acme" })).toThrow(SyncError);
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
