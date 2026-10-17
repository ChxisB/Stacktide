import { expect, test } from "bun:test";
import { DomainError } from "./errors";

test("carries code, status and a client-safe message", () => {
  const e = new DomainError("project_not_found", 404, "Project not found");
  expect(e).toBeInstanceOf(Error);
  expect({ code: e.code, status: e.status, message: e.message }).toEqual({
    code: "project_not_found",
    status: 404,
    message: "Project not found",
  });
});

test("only 4xx and 5xx statuses are allowed", () => {
  for (const bad of [200, 399, 600, 404.5, Number.NaN]) {
    expect(() => new DomainError("x", bad, "m")).toThrow(RangeError);
  }
});
