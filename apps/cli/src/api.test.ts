import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiUrlOf, call, resolveApi } from "./api";
import { CliError, type Context } from "./cli";
import { saveConfig } from "./config";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-api-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const failed = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("did not fail");
    },
    (e: unknown) => e as CliError,
  );

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
};

describe("apiUrlOf", () => {
  test("keeps the origin of an https URL, and of an http one for this machine", () => {
    for (const [given, origin] of [
      ["https://orch.example.com", "https://orch.example.com"],
      ["https://orch.example.com/", "https://orch.example.com"],
      ["HTTPS://Orch.Example.com:8443", "https://orch.example.com:8443"],
      ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
      ["http://localhost:3000/", "http://localhost:3000"],
      ["http://[::1]:3000", "http://[::1]:3000"],
    ] as const) {
      expect(apiUrlOf(given)).toBe(origin);
    }
  });

  test("refuses plain http elsewhere, other schemes, and anything that is not an origin; the message never repeats the value", () => {
    const bad = [
      "http://orch.example.com",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://0.0.0.0:3000",
      "http://10.0.0.5",
      "ftp://orch.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
      "orch.example.com",
      "https://hunter2:hunter2@orch.example.com",
      "https://hunter2@orch.example.com",
      "https://orch.example.com/hunter2",
      "https://orch.example.com/?hunter2=1",
      "https://orch.example.com/#hunter2",
    ];
    for (const given of bad) {
      const error = refused(() => apiUrlOf(given));
      expect([given, error instanceof CliError && error.exitCode]).toEqual([given, 2]);
      expect((error as Error).message).not.toContain(given || "\u0000");
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});

const ctx = (env: Record<string, string>): Context => ({
  io: { out: () => {}, err: () => {} },
  env: { ORCH_CONFIG: join(dir, "config.json"), ...env },
  cwd: dir,
  home: dir,
  stdin: async () => "",
  open: async () => {},
  confirm: async () => false,
  json: false,
});

describe("resolveApi", () => {
  test("says what is missing when there is no API at all", async () => {
    await rm(join(dir, "config.json"), { force: true });
    const error = await failed(resolveApi(ctx({})));
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("--api-url");
  });

  test("the URL is the flag, else ORCH_API_URL, else the config's", async () => {
    await saveConfig(join(dir, "config.json"), {
      apiUrl: "https://config.example.com",
      token: "t",
    });
    const env = { ORCH_API_URL: "https://env.example.com" };
    expect((await resolveApi(ctx(env), "https://flag.example.com")).apiUrl).toBe(
      "https://flag.example.com",
    );
    expect((await resolveApi(ctx(env))).apiUrl).toBe("https://env.example.com");
    expect((await resolveApi(ctx({}))).apiUrl).toBe("https://config.example.com");
  });

  test("every source is held to the same rules, the config's too", async () => {
    await saveConfig(join(dir, "config.json"), { apiUrl: "http://orch.example.com" });
    expect(await failed(resolveApi(ctx({})))).toBeInstanceOf(CliError);
    expect(
      await failed(resolveApi(ctx({ ORCH_API_URL: "http://orch.example.com" }))),
    ).toBeInstanceOf(CliError);
    expect(await failed(resolveApi(ctx({}), "http://orch.example.com"))).toBeInstanceOf(CliError);
  });

  test("a stored token goes only to the API that issued it", async () => {
    await saveConfig(join(dir, "config.json"), {
      apiUrl: "https://orch.example.com",
      token: "stored-token",
    });
    expect((await resolveApi(ctx({}))).token).toBe("stored-token");
    expect((await resolveApi(ctx({}), "https://ORCH.example.com/")).token).toBe("stored-token");
    expect((await resolveApi(ctx({}), "https://other.example.com")).token).toBeUndefined();
    expect(
      (await resolveApi(ctx({ ORCH_API_URL: "https://other.example.com" }))).token,
    ).toBeUndefined();
    expect((await resolveApi(ctx({}), "https://orch.example.com:8443")).token).toBeUndefined();
  });

  test("ORCH_TOKEN is the user's own choice and goes wherever the URL says; an empty one is nothing", async () => {
    await saveConfig(join(dir, "config.json"), {
      apiUrl: "https://orch.example.com",
      token: "stored-token",
    });
    const env = { ORCH_TOKEN: "env-token" };
    expect((await resolveApi(ctx(env))).token).toBe("env-token");
    expect((await resolveApi(ctx(env), "https://other.example.com")).token).toBe("env-token");
    expect((await resolveApi(ctx({ ORCH_TOKEN: "" }))).token).toBe("stored-token");
    await rm(join(dir, "config.json"));
    expect((await resolveApi(ctx(env), "https://other.example.com")).token).toBe("env-token");
  });
});

describe("call", () => {
  const api = "https://orch.example.com";
  const reply = (status: number, value?: object) => async () => ({
    data: status < 400 ? ((value ?? null) as unknown) : null,
    error: status < 400 ? null : { status, value },
    status,
  });

  test("returns the data, and null for an answer with none", async () => {
    expect(await call(api, reply(200, { a: 1 }))).toEqual({ a: 1 });
    expect(await call(api, reply(204))).toBeNull();
    // the client gives an empty body as ""
    expect(await call(api, async () => ({ data: "", error: null, status: 204 }))).toBe("");
  });

  test("a 401 says to sign in again, whatever the problem says", async () => {
    const error = await failed(
      call(api, reply(401, { detail: "Sign in first", code: "unauthenticated" })),
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe("your token is invalid or has expired; run: orch login");
  });

  test("any other problem is its detail (or title) and code", async () => {
    const base = { type: "x", title: "Bad", status: 400, request_id: "r", code: "bad_thing" };
    expect((await failed(call(api, reply(400, { ...base, detail: "Nope" })))).message).toBe(
      "Nope (bad_thing)",
    );
    expect((await failed(call(api, reply(400, base)))).message).toBe("Bad (bad_thing)");
  });

  test("an answer that is not a problem is named by its status", async () => {
    expect((await failed(call(api, reply(502)))).message).toBe(`${api} answered 502`);
  });

  test("a call the client reports as never answered says which API, and nothing of the exception", async () => {
    const never = async () => ({
      data: null,
      error: {
        status: 503,
        value: new TypeError("Unable to connect. Authorization: Bearer orch_secret-token"),
      },
      status: 503,
    });
    const error = await failed(call(api, never));
    expect(error.message).toBe(`cannot reach ${api}`);
  });

  test("an answer that is not JSON is not an orch API", async () => {
    const page = async () => ({ data: "<html>sign in</html>", error: null, status: 200 });
    expect((await failed(call(api, page))).message).toBe(`${api} does not look like an orch API`);
    expect((await failed(call(api, reply(500, { code: 7 })))).message).toBe(`${api} answered 500`);
  });

  test("a call that cannot be made says which API, and nothing of the request", async () => {
    const error = await failed(
      call(api, async () => {
        throw new TypeError("fetch failed: Authorization: Bearer orch_secret-token");
      }),
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(`cannot reach ${api}`);
  });
});
