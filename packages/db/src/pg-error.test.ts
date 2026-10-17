import { expect, test } from "bun:test";
import { pgCode } from "./pg-error";

const server = (errno: string) => ({ code: "ERR_POSTGRES_SERVER_ERROR", errno });

test("finds the SQLSTATE on the error or anywhere down its cause chain", () => {
  expect(pgCode(server("23505"))).toBe("23505");
  expect(pgCode(new Error("wrapped", { cause: server("23503") }))).toBe("23503");
});

test("ignores errors the server did not send", () => {
  expect(pgCode(undefined)).toBeUndefined();
  expect(pgCode("23505")).toBeUndefined();
  expect(pgCode(new Error("plain"))).toBeUndefined();
  expect(pgCode({ errno: "23505" })).toBeUndefined();
  expect(pgCode({ code: "ERR_POSTGRES_CONNECTION_REFUSED", errno: "ECONN" })).toBeUndefined();
  expect(pgCode({ code: "EPIPE", errno: "EPIPE" })).toBeUndefined();
  expect(pgCode({ ...server("x"), errno: -2 })).toBeUndefined();
});

test("terminates on a cyclic cause chain", () => {
  const a: { cause?: unknown } = {};
  a.cause = a;
  expect(pgCode(a)).toBeUndefined();
});
