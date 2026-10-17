import { apiUrlOf, call, clientFor, resolveApi } from "./api";
import { CliError, type Command, type Context, parse } from "./cli";
import { configPath, loadConfig, saveConfig } from "./config";

const TOKEN = /^[A-Za-z0-9._-]{8,200}$/;
const FIVE_MINUTES = 300_000;

const randomToken = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("base64url");
const same = (a: string, b: string) => sha256(a) === sha256(b);

const say = (ctx: Context, text: string, doc: object) =>
  ctx.io.out(ctx.json ? JSON.stringify(doc) : text);

const page = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      connection: "close", // the listener goes away right after: no connection should outlive the answer
    },
  });

/**
 * The browser sign-in (OAuth loopback with PKCE, RFC 8252): listens on this machine only, sends the
 * browser to the API, receives a one-time code on `/callback` and trades it, with a verifier that
 * never left this process, for a token. Returns the token.
 */
async function browserSignIn(ctx: Context, apiUrl: string, timeoutMs: number): Promise<string> {
  const [state, verifier] = [randomToken(24), randomToken(32)];
  const code = Promise.withResolvers<string>();
  let used = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/callback") return page(404, "not found");
      // whatever else reaches this port (another page, a scan) cannot end the sign-in
      const given = url.searchParams.get("state");
      if (!given || !same(given, state)) return page(400, "This is not the sign-in orch started.");
      if (used) return page(410, "This sign-in has already been answered.");
      used = true;
      const answer = url.searchParams.get("code");
      if (url.searchParams.has("error") || !answer) {
        code.reject(new CliError("the sign-in was not completed in the browser"));
        return page(200, "The sign-in was not completed. You can close this tab.");
      }
      code.resolve(answer);
      return page(200, "Signed in. You can close this tab and go back to the terminal.");
    },
  });
  let timer: Timer | undefined;
  try {
    const target = `${apiUrl}/auth/cli?${new URLSearchParams({
      port: String(server.port),
      state,
      challenge: sha256(verifier),
    })}`;
    // progress goes to stderr so that stdout stays one document under --json
    ctx.io.err(`Opening your browser to sign in. If it does not open, visit:\n  ${target}`);
    ctx.open(target).catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CliError("timed out waiting for the browser; run: orch login")),
        timeoutMs,
      );
    });
    const answer = await Promise.race([code.promise, timeout]);
    const made = await call(apiUrl, () =>
      clientFor(apiUrl).auth.cli.token.post({ code: answer, verifier }),
    );
    return made.token;
  } finally {
    clearTimeout(timer);
    // Stop listening now, but let the answer to the browser finish; a connection that lingers (a
    // browser's speculative one) is cut after a moment so it cannot keep the process alive.
    void server.stop();
    setTimeout(() => void server.stop(true), 500).unref();
  }
}

/** The commands that sign in and out; `timeoutMs` is how long the browser sign-in waits. */
export function authCommands({ timeoutMs = FIVE_MINUTES } = {}): Record<string, Command> {
  return {
    login: {
      summary: "sign in (browser, or --with-token to read a token from standard input)",
      async run(ctx, args) {
        const { values } = parse(args, {
          "api-url": { type: "string" },
          "with-token": { type: "boolean" },
        });
        const { apiUrl, config } = await resolveApi(ctx, values["api-url"]);
        let token: string;
        if (values["with-token"]) {
          token = (await ctx.stdin()).trim();
          if (!TOKEN.test(token)) {
            throw new CliError(
              "expected an API token on standard input, e.g.: echo $TOKEN | orch login --with-token",
              2,
            );
          }
          await call(apiUrl, () => clientFor(apiUrl, token).auth.whoami.get());
        } else {
          token = await browserSignIn(ctx, apiUrl, timeoutMs);
        }
        await saveConfig(configPath(ctx.env, ctx.home), { ...config, apiUrl, token });
        say(ctx, `signed in to ${apiUrl}`, { apiUrl, signedIn: true });
      },
    },
    whoami: {
      summary: "show who the stored token signs you in as, and its organizations",
      async run(ctx, args) {
        const { values } = parse(args, { "api-url": { type: "string" } });
        const { apiUrl, token } = await resolveApi(ctx, values["api-url"]);
        if (!token) throw new CliError("not signed in; run: orch login");
        const client = clientFor(apiUrl, token);
        const [me, orgs] = await Promise.all([
          call(apiUrl, () => client.auth.whoami.get()),
          call(apiUrl, () => client.organizations.get({ query: { limit: 100 } })),
        ]);
        const organizations = orgs.items.map(({ id, slug, name }) => ({ id, slug, name }));
        const lines = [
          `api:           ${apiUrl}`,
          `signed in as:  ${me.kind} ${me.id}`,
          `scopes:        ${me.scopes ? me.scopes.join(", ") : "(not limited)"}`,
          ...(me.environmentId ? [`environment:   ${me.environmentId}`] : []),
          `organizations: ${organizations.length === 0 ? "(none)" : ""}`,
          ...organizations.map((o) => `  ${o.slug}  ${o.name}`),
          ...(orgs.nextCursor ? ["  (more not shown)"] : []),
        ];
        say(ctx, lines.join("\n"), { apiUrl, ...me, organizations });
      },
    },
    logout: {
      summary: "revoke the stored token and forget it",
      async run(ctx, args) {
        parse(args, {});
        const path = configPath(ctx.env, ctx.home);
        const { apiUrl, token } = await loadConfig(path);
        if (!token) {
          say(ctx, "not signed in", { signedIn: false, revoked: false });
          return;
        }
        // best effort: a token the server cannot reach is still forgotten here
        let problem: string | undefined;
        try {
          if (!apiUrl) throw new CliError("the config names no API");
          const origin = apiUrlOf(apiUrl);
          await call(origin, () => clientFor(origin, token).auth.cli.logout.post());
        } catch (e) {
          problem = e instanceof CliError ? e.message : "failed";
        }
        await saveConfig(path, apiUrl ? { apiUrl } : {});
        say(
          ctx,
          problem
            ? `signed out here, but the token was not revoked on the server: ${problem}`
            : "signed out; the token is revoked",
          { signedIn: false, revoked: problem === undefined, ...(problem ? { problem } : {}) },
        );
      },
    },
  };
}
