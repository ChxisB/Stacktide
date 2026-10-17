import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { hashToken, randomToken } from "@orch/api/tokens";
import { createLogger } from "@orch/core";
import { apiTokens, auditEvents, createOrganization, createSession, upsertUser } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq, sql } from "drizzle-orm";
import { authCommands } from "./auth";
import { runCli } from "./cli";
import { loadConfig, saveConfig } from "./config";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let configFile: string;
let cookie: string;
let userId: string;

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: () => ({ orgRoles: orgRoles, projectRoles: {} }),
    }),
    ready: async () => {},
  });
let orgRoles: Record<string, "owner"> = {};

beforeAll(async () => {
  t = await createTestDb();
  const org = await createOrganization(t.db, { slug: "acme", name: "Acme Inc" });
  orgRoles = { [org.id]: "owner" };
  const user = await upsertUser(t.db, { gitlabId: 901, username: "alice", name: "Alice" });
  userId = user.id;
  const session = randomToken();
  await createSession(t.db, { userId, tokenHash: hashToken(session), ttlMs: 3_600_000 });
  cookie = `orch_session=${session}`;
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-auth-"));
});
afterAll(async () => {
  await app.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  configFile = join(dir, `config-${crypto.randomUUID()}.json`);
});

/** Every line any command printed, and every token any test saw: none may be in the other. */
const printed: string[] = [];
const tokens = new Set<string>();

interface Run {
  stdin?: string;
  open?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  env?: Record<string, string>;
}
async function orch(argv: string[], options: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: configFile, ...options.env },
    cwd: dir,
    home: dir,
    stdin: async () => options.stdin ?? "",
    open: async (url) => {
      await options.open?.(url);
    },
    version: "0.0.0",
    commands: authCommands({ timeoutMs: options.timeoutMs ?? 5000 }),
  });
  printed.push(...out, ...err);
  return { code, out, err };
}

/** The part of a sign-in URL the CLI printed that the browser would use. */
const parts = (url: string) => {
  const q = new URL(url).searchParams;
  return { port: q.get("port") ?? "", state: q.get("state") ?? "" };
};
const callback = (url: string, query: Record<string, string>) => {
  const { port, state } = parts(url);
  return fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams({ state, ...query })}`);
};

/** A browser with a session: follows the API's redirect to the CLI's port. */
const signedInBrowser = (url: string) => async () => {
  const hop = await fetch(url, { headers: { cookie }, redirect: "manual" });
  expect(hop.status).toBe(302);
  const to = hop.headers.get("location") ?? "";
  expect(to.startsWith("http://127.0.0.1:")).toBe(true);
  expect((await fetch(to)).status).toBe(200);
};
const browse = (url: string) => void signedInBrowser(url)();

async function signIn(extra: Run = {}) {
  const res = await orch(["login", "--api-url", api], { open: browse, ...extra });
  expect(res.code).toBe(0);
  const config = await loadConfig(configFile);
  if (config.token) tokens.add(config.token);
  return config;
}

/** A token made the long way round, for tests that need one with other limits. */
async function mintToken(scopes: string[]) {
  const res = await fetch(`${api}/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "test", scopes }),
  });
  expect(res.status).toBe(201);
  const made = (await res.json()) as { id: string; token: string };
  tokens.add(made.token);
  return made;
}

describe("orch login in the browser", () => {
  test("stores a token for the API in a private file, and says only that it signed in", async () => {
    const res = await orch(["login", "--api-url", api], { open: browse });
    expect(res).toMatchObject({ code: 0, out: [`signed in to ${api}`] });
    const config = await loadConfig(configFile);
    if (config.token) tokens.add(config.token);
    expect(config.apiUrl).toBe(api);
    expect(config.token).toMatch(/^orch_[\w-]{8}\.[\w-]{43}$/);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    // the URL it asked the browser to open is the only thing on stderr; it holds no secret
    expect(res.err.join("\n")).toContain(`${api}/auth/cli?port=`);
    expect(res.err.join("\n")).not.toContain(config.token ?? "?");
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "token.create"))
      .orderBy(sql`${auditEvents.at} desc`)
      .limit(1);
    expect(row).toMatchObject({ actorKind: "user", actorId: userId });
    expect(row?.metadata).toMatchObject({ via: "cli_login", scopes: ["*"] });
  });

  test("under --json stdout is one document, and the browser URL goes to stderr", async () => {
    const res = await orch(["--json", "login", "--api-url", api], { open: browse });
    expect(res.code).toBe(0);
    expect(res.out).toEqual([JSON.stringify({ apiUrl: api, signedIn: true })]);
    expect(res.err.join("\n")).toContain("/auth/cli?port=");
    const config = await loadConfig(configFile);
    if (config.token) tokens.add(config.token);
  });

  test("remembers the API: a later login needs no --api-url", async () => {
    await signIn();
    const again = await orch(["login"], { open: browse });
    expect(again.code).toBe(0);
    const config = await loadConfig(configFile);
    if (config.token) tokens.add(config.token);
  });

  test("a browser that is not signed in is sent to sign in, and the CLI keeps waiting until it times out", async () => {
    let location = "";
    const res = await orch(["login", "--api-url", api], {
      timeoutMs: 100,
      open: async (url) => {
        const hop = await fetch(url, { redirect: "manual" });
        location = hop.headers.get("location") ?? "";
      },
    });
    expect(location).toStartWith("/auth/login?return_to=");
    expect(res.code).toBe(1);
    expect(res.err.at(-1)).toBe("error: timed out waiting for the browser; run: orch login");
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("stops listening when it is done, whichever way it ended", async () => {
    let url = "";
    await orch(["login", "--api-url", api], {
      timeoutMs: 100,
      open: (u) => {
        url = u;
      },
    });
    const refused = await callback(url, { code: "x" }).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });

  test("a login that was denied in the browser fails and stores nothing", async () => {
    const res = await orch(["login", "--api-url", api], {
      open: (url) => void callback(url, { error: "access_denied" }),
    });
    expect(res.code).toBe(1);
    expect(res.err.at(-1)).toBe("error: the sign-in was not completed in the browser");
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("an answer that carries both a code and an error is not a sign-in", async () => {
    const res = await orch(["login", "--api-url", api], {
      open: (url) => void callback(url, { code: randomToken(), error: "access_denied" }),
    });
    expect(res.code).toBe(1);
    expect(res.err.at(-1)).toBe("error: the sign-in was not completed in the browser");
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("the listener answers this machine only", async () => {
    // a machine without a network address has nothing to try; the check then proves nothing
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address;
    let reachable: boolean | undefined;
    await signIn({
      open: async (url) => {
        if (lan) {
          // refused or dropped (a firewall) both mean not reachable
          reachable = await fetch(
            `http://${lan}:${parts(url).port}/callback?state=${parts(url).state}`,
            { signal: AbortSignal.timeout(1000) },
          ).then(
            () => true,
            () => false,
          );
        }
        browse(url);
      },
    });
    if (lan) expect(reachable).toBe(false);
  });

  test("a code the API refuses fails and stores nothing", async () => {
    const res = await orch(["login", "--api-url", api], {
      open: (url) => void callback(url, { code: randomToken() }),
    });
    expect(res.code).toBe(1);
    expect(res.err.at(-1)).toContain("(invalid_login_code)");
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("a request with the wrong state is turned away and does not end the sign-in", async () => {
    let stray = 0;
    const res = await orch(["login", "--api-url", api], {
      open: async (url) => {
        const { port } = parts(url);
        stray = (
          await fetch(
            `http://127.0.0.1:${port}/callback?state=${randomToken()}&code=${randomToken()}`,
          )
        ).status;
        const none = await fetch(`http://127.0.0.1:${port}/callback?code=${randomToken()}`);
        expect(none.status).toBe(400);
        expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
        await signedInBrowser(url)();
      },
    });
    expect(stray).toBe(400);
    expect(res.code).toBe(0);
    const config = await loadConfig(configFile);
    if (config.token) tokens.add(config.token);
  });

  test("answers once: a second request with the right state is too late", async () => {
    let second = 0;
    const res = await orch(["login", "--api-url", api], {
      open: async (url) => {
        const hop = await fetch(url, { headers: { cookie }, redirect: "manual" });
        const real = new URL(hop.headers.get("location") ?? "");
        // the first answer carries a bad code, the second the real one
        await callback(url, { code: randomToken() });
        second = (await fetch(real)).status;
      },
    });
    expect(second).toBe(410);
    expect(res.code).toBe(1);
  });

  test("does not use a browser at all when the URL is not an acceptable API", async () => {
    let opened = false;
    for (const url of ["http://orch.example.com", "https://user:hunter2@orch.example.com"]) {
      const res = await orch(["login", "--api-url", url], {
        open: () => {
          opened = true;
        },
      });
      expect(res.code).toBe(2);
      expect(res.err.join("\n")).not.toContain("hunter2");
    }
    expect(opened).toBe(false);
  });

  test("an API that cannot be reached is named, and the wait ends", async () => {
    const res = await orch(["login", "--api-url", "http://127.0.0.1:1"], {
      open: async (url) => {
        const { port, state } = parts(url);
        await fetch(`http://127.0.0.1:${port}/callback?state=${state}&code=${randomToken()}`);
      },
    });
    expect(res).toMatchObject({
      code: 1,
      err: expect.arrayContaining(["error: cannot reach http://127.0.0.1:1"]),
    });
  });
});

describe("orch login --with-token", () => {
  test("reads the token from standard input, checks it with the API and stores it", async () => {
    const { token } = await mintToken(["organization.read"]);
    const res = await orch(["login", "--api-url", api, "--with-token"], { stdin: `${token}\n` });
    expect(res).toEqual({ code: 0, out: [`signed in to ${api}`], err: [] });
    expect(await loadConfig(configFile)).toEqual({ apiUrl: api, token });
  });

  test("refuses a token the API does not know, and stores nothing", async () => {
    const bad = `orch_AAAAAAAA.${"B".repeat(43)}`;
    const res = await orch(["login", "--api-url", api, "--with-token"], { stdin: bad });
    expect(res).toMatchObject({
      code: 1,
      err: ["error: your token is invalid or has expired; run: orch login"],
    });
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("refuses standard input that is not a token, without repeating it", async () => {
    for (const stdin of ["", "  \n", "two words", "line one\nline two", "x".repeat(300), "short"]) {
      const res = await orch(["login", "--api-url", api, "--with-token"], { stdin });
      expect(res.code).toBe(2);
      expect(res.err.join("\n")).not.toContain("two words");
      expect(res.err.join("\n")).toContain("standard input");
    }
    expect(await loadConfig(configFile)).toEqual({});
  });

  test("is not an option that takes the token as a value", async () => {
    const res = await orch(["login", "--api-url", api, "--with-token", "orch_x"], {
      stdin: "",
    });
    // a stray word is not mistaken for the token: standard input is what is read
    expect(res.code).toBe(2);
    expect(res.err.join("\n")).not.toContain("orch_x");
  });
});

describe("orch whoami", () => {
  test("says who the token is, what it may do and which organizations it sees", async () => {
    await signIn();
    const res = await orch(["whoami"]);
    expect(res.code).toBe(0);
    expect(res.out.join("\n")).toContain(`api:           ${api}`);
    expect(res.out.join("\n")).toMatch(/signed in as: {2}token [0-9a-f-]{36}/);
    expect(res.out.join("\n")).toContain("scopes:        *");
    expect(res.out.join("\n")).toContain("  acme  Acme Inc");
    expect(res.err).toEqual([]);
  });

  test("--json is one document with the same facts", async () => {
    const { token } = await signIn().then((c) => ({ token: c.token }));
    const res = await orch(["--json", "whoami"]);
    expect(res.out).toHaveLength(1);
    const doc = JSON.parse(res.out[0] ?? "");
    expect(doc).toMatchObject({
      apiUrl: api,
      kind: "token",
      scopes: ["*"],
      environmentId: null,
      organizations: [{ slug: "acme", name: "Acme Inc" }],
    });
    expect(JSON.stringify(doc)).not.toContain(token ?? "?");
  });

  test("a limited token shows its limits", async () => {
    const { token } = await mintToken(["organization.read"]);
    const res = await orch(["whoami", "--api-url", api], { env: { ORCH_TOKEN: token } });
    expect(res.out.join("\n")).toContain("scopes:        organization.read");
  });

  test("is not signed in without a token", async () => {
    expect(await orch(["whoami", "--api-url", api])).toMatchObject({
      code: 1,
      err: ["error: not signed in; run: orch login"],
    });
    expect((await orch(["whoami"])).code).toBe(2); // and no API to ask either
  });

  test("an expired or revoked token is told to sign in again, and is not printed", async () => {
    const config = await signIn();
    await t.db
      .update(apiTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(apiTokens.tokenHash, hashToken(config.token ?? "")));
    for (const argv of [["whoami"], ["--json", "whoami"]]) {
      const res = await orch(argv);
      expect(res.code).toBe(1);
      expect(res.err.join("\n")).toContain("your token is invalid or has expired; run: orch login");
      expect(res.out).toEqual([]);
    }
  });

  test("a stored token is not sent to another API", async () => {
    await signIn();
    const seen: (string | null)[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get("authorization"));
        return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const elsewhere = `http://127.0.0.1:${other.port}`;
      for (const argv of [["whoami", "--api-url", elsewhere], ["whoami"]]) {
        const res = await orch(argv, argv.length > 1 ? {} : { env: { ORCH_API_URL: elsewhere } });
        expect(res).toMatchObject({ code: 1, err: ["error: not signed in; run: orch login"] });
      }
      expect(seen).toEqual([]);
      // the user's own ORCH_TOKEN, though, goes where the user points it
      await orch(["whoami", "--api-url", elsewhere], {
        env: { ORCH_TOKEN: "orch_explicit-token" },
      });
      expect(new Set(seen)).toEqual(new Set(["Bearer orch_explicit-token"]));
    } finally {
      await other.stop(true);
    }
  });

  test("an API that is down is named", async () => {
    await saveConfig(configFile, { apiUrl: "http://127.0.0.1:1", token: "orch_dead-token" });
    const res = await orch(["whoami"]);
    expect(res).toMatchObject({ code: 1, err: ["error: cannot reach http://127.0.0.1:1"] });
  });
});

describe("orch logout", () => {
  test("revokes the token on the server, forgets it, and keeps the API", async () => {
    const config = await signIn();
    const res = await orch(["logout"]);
    expect(res).toEqual({ code: 0, out: ["signed out; the token is revoked"], err: [] });
    expect(await loadConfig(configFile)).toEqual({ apiUrl: api });
    const after = await fetch(`${api}/auth/whoami`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    expect(after.status).toBe(401);
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "token.revoke"))
      .orderBy(sql`${auditEvents.at} desc`)
      .limit(1);
    expect(row?.metadata).toMatchObject({ via: "cli_logout" });
    expect((await orch(["whoami"])).err).toEqual(["error: not signed in; run: orch login"]);
  });

  test("--json says what happened", async () => {
    await signIn();
    expect((await orch(["--json", "logout"])).out).toEqual([
      JSON.stringify({ signedIn: false, revoked: true }),
    ]);
  });

  test("when nobody is signed in there is nothing to do", async () => {
    expect(await orch(["logout"])).toEqual({ code: 0, out: ["not signed in"], err: [] });
    await saveConfig(configFile, { apiUrl: api });
    expect((await orch(["logout"])).out).toEqual(["not signed in"]);
  });

  test("a token the server cannot be asked about is still forgotten, and the user is told", async () => {
    await saveConfig(configFile, { apiUrl: "http://127.0.0.1:1", token: "orch_dead-token" });
    const res = await orch(["logout"]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      "signed out here, but the token was not revoked on the server: cannot reach http://127.0.0.1:1",
    ]);
    expect(await loadConfig(configFile)).toEqual({ apiUrl: "http://127.0.0.1:1" });
  });

  test("a token the server already rejects is forgotten too", async () => {
    const config = await signIn();
    await t.db
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(eq(apiTokens.tokenHash, hashToken(config.token ?? "")));
    const res = await orch(["logout"]);
    expect(res.out[0]).toStartWith("signed out here, but the token was not revoked on the server");
    expect(await loadConfig(configFile)).toEqual({ apiUrl: api });
  });

  test("never sends the token over plain http to a host that is not this machine", async () => {
    const seen: string[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(req.url);
        return new Response(null, { status: 204 });
      },
    });
    try {
      // 0.0.0.0 reaches the server above, but is not a name for this machine that the CLI trusts
      await saveConfig(configFile, { apiUrl: `http://0.0.0.0:${other.port}`, token: "orch_t0ken" });
      const res = await orch(["logout"]);
      expect(res.out[0]).toBe(
        "signed out here, but the token was not revoked on the server: the API URL must use https (http is allowed for localhost only)",
      );
      expect(seen).toEqual([]);
    } finally {
      await other.stop(true);
    }
  });

  test("does not send the stored token to an API the config does not name", async () => {
    const seen: string[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(req.url);
        return new Response(null, { status: 204 });
      },
    });
    try {
      // a hand-edited config pointing at plain http on a remote host is refused, not obeyed
      await writeFile(
        configFile,
        JSON.stringify({ apiUrl: "http://orch.example.com", token: "orch_t" }),
        {
          mode: 0o600,
        },
      );
      const res = await orch(["logout"], {
        env: { ORCH_API_URL: `http://127.0.0.1:${other.port}` },
      });
      expect(res.out[0]).toStartWith("signed out here, but the token was not revoked");
      expect(seen).toEqual([]);
    } finally {
      await other.stop(true);
    }
  });
});

test("no command printed any token it handled, on any path", () => {
  expect(printed.length).toBeGreaterThan(20);
  expect(tokens.size).toBeGreaterThan(3);
  const everything = printed.join("\n");
  for (const token of tokens) {
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split(".")[1] ?? "?");
  }
});
