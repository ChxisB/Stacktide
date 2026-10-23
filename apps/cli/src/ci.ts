import { z } from "zod";
import { call, clientFor, resolveApi } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { formatVariables } from "./format";

const USAGE =
  "usage: orch ci login [--state] [--api-url <url>] [--id-token-env <NAME>] [--audience <aud>]";
const DEFAULT_VARIABLE = "ORCH_ID_TOKEN";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
/** header.payload.signature, each base64url: all that is checked before the value leaves this machine. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The API refuses more; so does this, instead of sending it. */
const MAX_ID_TOKEN = 8192;

const REFUSED =
  "the id_token was refused: its aud must be the audience this API is set up for (ORCH_CI_AUDIENCE), it must come from this API's GitLab or a GitHub repository linked to a project, and it must not have expired";

/** What a GitHub Actions runner answers a request for an identity token with. */
const issued = z.object({ value: z.string().max(MAX_ID_TOKEN).regex(JWT) });

/**
 * A GitHub Actions job's identity token for an audience, from the runner's own endpoint (FRG-23). Its request token
 * is sent only to a https address (or a loopback one, for a test): the address comes from the job's environment,
 * and nothing it says reaches the output.
 */
async function fromRunner(env: Record<string, string | undefined>, audience: string) {
  const [address, bearer] = [env.ACTIONS_ID_TOKEN_REQUEST_URL, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN];
  if (!address) return undefined;
  if (!bearer) {
    throw new CliError(
      "the job cannot ask for an identity token: give the workflow the permission id-token: write",
      2,
    );
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new CliError("ACTIONS_ID_TOKEN_REQUEST_URL is not an address", 2);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError("ACTIONS_ID_TOKEN_REQUEST_URL is not a https address", 2);
  }
  url.searchParams.set("audience", audience);
  let value: unknown;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    value = await res.json();
  } catch {
    throw new CliError("the runner would not give the job an identity token");
  }
  const got = issued.safeParse(value);
  if (!got.success) throw new CliError("the runner did not answer with an identity token");
  return got.data.value;
}

const exchanged = z.object({
  token: z.string().min(1),
  // the typed client has already turned the timestamp into a Date
  expiresAt: z.coerce.date(),
  scopes: z.array(z.string()),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
});

/**
 * `orch ci login`, for a GitLab CI job or a GitHub Actions one: trades the job's `id_token` for a short-lived token for its
 * project and environment. It prints `export` lines, so `eval "$(orch ci login)"` signs the rest of the
 * job in: `orch run`, `pull` and `export` then find the API, the token and the environment in the
 * job's environment. Nothing is written to disk, and the id_token is read from the environment, never
 * the command line. shortcut: no `orch ci login && orch run` in one process, a process cannot set its
 * parent's environment; the one-line form would need `run` to log in by itself.
 *
 * `--state` asks for the other token, the one for the project's Terraform state (ADR-0017): it prints
 * `ORCH_STATE_TOKEN` and the project's address, and leaves `ORCH_TOKEN` and `ORCH_ENV` alone, so a job can
 * hold both and the state token never reads an environment's values.
 */
export function ciCommands(): Record<string, Command> {
  return {
    ci: {
      summary: `sign a GitLab CI or GitHub Actions job in from its id_token: eval "$(orch ci login)"`,
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          "api-url": { type: "string" },
          "id-token-env": { type: "string" },
          audience: { type: "string" },
          state: { type: "boolean" },
        });
        if (positionals.length !== 1 || positionals[0] !== "login") throw new CliError(USAGE, 2);

        const variable = values["id-token-env"] ?? DEFAULT_VARIABLE;
        if (!NAME.test(variable)) {
          throw new CliError("--id-token-env must be the name of an environment variable", 2);
        }
        let idToken = ctx.env[variable]?.trim();
        if (!idToken && ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
          // a GitHub Actions job has no token waiting: it asks the runner, for the platform's audience
          const audience = values.audience ?? ctx.env.ORCH_AUDIENCE;
          if (!audience) {
            throw new CliError(
              "no audience: give --audience or ORCH_AUDIENCE (ORCH_CI_AUDIENCE of the API)",
              2,
            );
          }
          idToken = await fromRunner(ctx.env, audience);
        }
        if (!idToken) {
          throw new CliError(
            `no id_token: give the job an id_tokens: entry named ${variable} (see docs/ci.md)`,
            2,
          );
        }
        // whatever else was put in the variable is not sent to a server
        if (idToken.length > MAX_ID_TOKEN || !JWT.test(idToken)) {
          throw new CliError(`${variable} does not hold an id_token`, 2);
        }

        const state = values.state === true;
        const { apiUrl } = await resolveApi(ctx, values["api-url"]);
        const got = exchanged.safeParse(
          await call(
            apiUrl,
            () =>
              clientFor(apiUrl).auth.ci.exchange.post({
                id_token: idToken,
                ...(state && { state: true }),
              }),
            REFUSED,
          ),
        );
        if (!got.success) throw new CliError(`${apiUrl} does not look like an orch API`);
        const { token, scopes, organizationId, projectId, environmentId } = got.data;
        const expiresAt = got.data.expiresAt.toISOString();

        const pairs = [
          { key: "ORCH_API_URL", value: apiUrl },
          { key: "ORCH_ORG", value: organizationId },
          { key: "ORCH_PROJECT", value: projectId },
          state ? { key: "ORCH_STATE_TOKEN", value: token } : { key: "ORCH_TOKEN", value: token },
          ...(environmentId ? [{ key: "ORCH_ENV", value: environmentId }] : []),
        ];
        // the token is the answer to this command and shown only here; stderr keeps stdout clean for `eval`
        say(ctx, formatVariables(pairs, "shell"), {
          apiUrl,
          token,
          expiresAt,
          scopes,
          organizationId,
          projectId,
          environmentId,
        });
        ctx.io.err(`signed in for this job until ${expiresAt}`);
        if (!environmentId && !state) {
          ctx.io.err(
            "warning: this job runs in no environment, so its token reads the project only; give the job environment: name: <slug> to read variables",
          );
        }
      },
    },
  };
}
