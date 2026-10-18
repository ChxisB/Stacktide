import { describe, expect, test } from "bun:test";
import { CloudError, type Fetch, reasonOf, send } from "./http";

const reply =
  (body: string, status = 200) =>
  async () =>
    new Response(body, { status });

describe("send", () => {
  test("answers the status and the text", async () => {
    expect(await send(reply("hello", 201), "https://x.test/", {})).toEqual({
      status: 201,
      text: "hello",
    });
  });

  test("never follows a redirect: a token must not travel to wherever it is sent", async () => {
    let seen: RequestInit | undefined;
    const f: Fetch = async (_url, init) => {
      seen = init;
      return new Response("", { status: 302, headers: { location: "https://evil.test/" } });
    };
    const r = await send(f, "https://x.test/", { headers: { authorization: "Bearer t" } });
    expect(seen?.redirect).toBe("manual");
    expect(r.status).toBe(302);
    expect(reasonOf(302)).toBe("unexpected");
  });

  test("a network failure is `network` and says nothing of the address or the cause", async () => {
    const f: Fetch = async () => {
      throw new Error("connect ECONNREFUSED https://user:hunter2@x.test");
    };
    const e = await send(f, "https://x.test/", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect((e as CloudError).reason).toBe("network");
    expect(String(e)).not.toContain("hunter2");
    expect(String(e)).not.toContain("x.test");
  });

  test("a call that outlasts the timeout is `timeout`", async () => {
    const f: Fetch = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const e = await send(f, "https://x.test/", {}, 20).catch((x: unknown) => x);
    expect((e as CloudError).reason).toBe("timeout");
  });

  test("a body over the cap is refused, not read to the end", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const e = await send(reply(big), "https://x.test/", {}).catch((x: unknown) => x);
    expect((e as CloudError).reason).toBe("unexpected");
  });
});

describe("reasonOf", () => {
  test("names the failures a person can act on", () => {
    expect([401, 403, 404, 429, 500, 503, 400, 409, 302].map(reasonOf)).toEqual([
      "unauthorized",
      "forbidden",
      "not_found",
      "rate_limited",
      "server",
      "server",
      "invalid",
      "invalid",
      "unexpected",
    ]);
  });
});
