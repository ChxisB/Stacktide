import { expect, test } from "bun:test";
import { ApiError, allPages, call } from "./api";

const answer =
  (status: number, data: unknown, error: unknown = null) =>
  async () => ({
    status,
    data,
    error,
  });

test("an answer is its data; a 204 has none", async () => {
  expect(await call(answer(200, { a: 1 }))).toEqual({ a: 1 });
  expect(await call(answer(204, null))).toBeNull();
});

test("a problem is an error with the API's own words, its status and its code", async () => {
  const problem = {
    status: 409,
    value: { code: "name_taken", title: "Conflict", detail: "That name is in use." },
  };
  const error = await call(answer(409, null, problem)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ message: "That name is in use.", status: 409, code: "name_taken" });
});

test("a problem without detail falls back to its title, then to the status", async () => {
  const titled = await call(answer(500, null, { status: 500, value: { title: "Broken" } })).catch(
    (e: unknown) => e,
  );
  expect(titled).toMatchObject({ message: "Broken", status: 500 });
  const bare = await call(
    answer(502, null, { status: 502, value: "<html>bad gateway</html>" }),
  ).catch((e: unknown) => e);
  expect(bare).toMatchObject({ message: "The server answered 502.", status: 502 });
});

test("no answer at all is status 0, whether the client threw or reported the exception", async () => {
  const threw = await call(async () => {
    throw new TypeError("fetch failed");
  }).catch((e: unknown) => e);
  expect(threw).toMatchObject({ status: 0 });
  expect((threw as Error).message).toContain("Cannot reach the server");
  const reported = await call(
    answer(0, null, { status: 0, value: new TypeError("fetch failed") }),
  ).catch((e: unknown) => e);
  expect(reported).toMatchObject({ status: 0 });
});

test("an empty answer is refused too: a null must not reach a screen as data", async () => {
  const error = await call(answer(200, null)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as Error).message).toContain("did not answer like the Stacktide API");
});

test("a page that is not the API's JSON is refused, and no message repeats what it said", async () => {
  const error = await call(answer(200, "<html>captive portal s3cret</html>")).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as Error).message).not.toContain("s3cret");
  expect((error as Error).message).toContain("did not answer like the Stacktide API");
});

test("a paged list is followed to its last page", async () => {
  const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
    first: { items: [1, 2], nextCursor: "second" },
    second: { items: [3], nextCursor: null },
  };
  const asked: (string | undefined)[] = [];
  const all = await allPages<number>(async (cursor) => {
    asked.push(cursor);
    return { status: 200, error: null, data: pages[cursor ?? "first"] ?? null };
  });
  expect(all).toEqual([1, 2, 3]);
  expect(asked).toEqual([undefined, "second"]);
});

test("a list that never ends is an error after 20 pages, not an endless loop", async () => {
  let asked = 0;
  const error = await allPages<number>(async () => {
    asked++;
    return { status: 200, error: null, data: { items: [asked], nextCursor: "more" } };
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(asked).toBe(20);
});

test("a page that fails fails the list, with the API's words", async () => {
  const error = await allPages<number>(async () => ({
    status: 500,
    data: null,
    error: { status: 500, value: { detail: "Down." } },
  })).catch((e: unknown) => e);
  expect(error).toMatchObject({ message: "Down.", status: 500 });
});
