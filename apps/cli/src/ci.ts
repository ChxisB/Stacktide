import { z } from "zod";
import { call, clientFor, resolveApi } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { formatVariables } from "./format";

const USAGE = "usage: orch ci login [--api-url <url>] [--id-token-env <NAME>]";
const DEFAULT_VARIABLE = "ORCH_ID_TOKEN";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
/** header.payload.signature, each base64url: all that is checked before the value leaves this machine. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The API refuses more; so does this, instead of sending it. */
const MAX_ID_TOKEN = 8192;

const REFUSED =
  "the id_token was refused: its aud must be the audience this API is set up for (ORCH_CI_AUDIENCE), it must come from this API's GitLab, and it must not have expired";

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
 * `orch ci login`, for a GitLab CI job: trades the job's `id_token` for a short-lived token for its
 * project and environment. It prints `export` lines, so `eval "$(orch ci login)"` signs the rest of the
 * job in: `orch run`, `pull` and `export` then find the API, the token and the environment in the
 * job's environment. Nothing is written to disk, and the id_token is read from the environment, never
 * the command line. shortcut: no `orch ci login && orch run` in one process, a process cannot set its
 * parent's environment; the one-line form would need `run` to log in by itself.
 */
export function ciCommands(): Record<string, Command> {
  return {
    ci: {
      summary: `sign a GitLab CI job in from its id_token: eval "$(orch ci login)"`,
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          "api-url": { type: "string" },
          "id-token-env": { type: "string" },
        });
        if (positionals.length !== 1 || positionals[0] !== "login") throw new CliError(USAGE, 2);

        const variable = values["id-token-env"] ?? DEFAULT_VARIABLE;
        if (!NAME.test(variable)) {
          throw new CliError("--id-token-env must be the name of an environment variable", 2);
        }
        const idToken = ctx.env[variable]?.trim();
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

        const { apiUrl } = await resolveApi(ctx, values["api-url"]);
        const got = exchanged.safeParse(
          await call(
            apiUrl,
            () => clientFor(apiUrl).auth.ci.exchange.post({ id_token: idToken }),
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
          { key: "ORCH_TOKEN", value: token },
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
        if (!environmentId) {
          ctx.io.err(
            "warning: this job runs in no environment, so its token reads the project only; give the job environment: name: <slug> to read variables",
          );
        }
      },
    },
  };
}
