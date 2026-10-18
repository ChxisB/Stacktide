import { describe, expect, test } from "bun:test";
import { CHANGE_REQUEST_STATUSES, diffOf, personRef } from "./change-requests";
import type { BulkOp } from "./variables";

describe("diffOf", () => {
  test("keeps names and actions and leaves every value out", () => {
    const ops: BulkOp[] = [
      { op: "set", key: "DB_PASSWORD", kind: "secret", value: "hunter2-very-secret" },
      { op: "set", key: "REGION", value: "eu-west-1" },
      { op: "rename", key: "OLD", to: "NEW" },
      { op: "delete", key: "GONE" },
    ];
    const diff = diffOf(ops);
    expect(diff).toEqual([
      { action: "set", key: "DB_PASSWORD", kind: "secret" },
      { action: "set", key: "REGION" },
      { action: "rename", key: "OLD", to: "NEW" },
      { action: "delete", key: "GONE" },
    ]);
    expect(JSON.stringify(diff)).not.toContain("hunter2");
    expect(JSON.stringify(diff)).not.toContain("eu-west-1");
  });
});

describe("personRef", () => {
  test("a person is one ref whether they use a session or a token", () => {
    const session = personRef({ kind: "user", id: "u-1" });
    const token = personRef({ kind: "token", id: "tok-9", userId: "u-1" });
    expect(session).toBe("user:u-1");
    expect(token).toBe(session);
  });

  test("without a user, the principal itself is the identity", () => {
    expect(personRef({ kind: "ci", id: "ci-1" })).toBe("ci:ci-1");
    expect(personRef({ kind: "token", id: "tok-9" })).toBe("token:tok-9");
    expect(personRef({ kind: "dev", id: "dev" })).toBe("dev:dev");
    expect(personRef({ kind: "token", id: "a", userId: "b" })).not.toBe(
      personRef({ kind: "token", id: "a" }),
    );
  });
});

test("the states are the ones the database allows", () => {
  expect([...CHANGE_REQUEST_STATUSES]).toEqual([
    "open",
    "approved",
    "applied",
    "rejected",
    "expired",
  ]);
});
