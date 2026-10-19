import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, resolveProject } from "./target";

const USAGE =
  "usage: orch lease issue --scopes <read_api,read_repository,read_registry> [--ttl <seconds>] [options] | orch lease list [options] | orch lease revoke <ID> [options]";

/** The typed client hands dates back as `Date`s: printed as the ISO text the API sent. */
const iso = (at: Date | string) => new Date(at).toISOString();

/** Seconds as a whole number, or a usage error that names the flag and not what was typed. */
function seconds(raw: string) {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 1) {
    throw new CliError("--ttl takes a whole number of seconds", 2);
  }
  return n;
}

/** `--scopes a,b`: the names only; which ones a lease may hold is the API's to say (so `post` below is cast). */
const scopesOf = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const leaseCommands = (): Record<string, Command> => ({
  lease: {
    summary:
      "a short-lived read-only GitLab token for a project: orch lease issue|list|revoke (the token is printed once, to stdout)",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        scopes: { type: "string" },
        ttl: { type: "string" },
      });
      const [step, id, ...extra] = positionals;
      const known = step === "issue" || step === "list" || step === "revoke";
      if (!known || extra.length > 0 || (step === "revoke") !== (id !== undefined)) {
        throw new CliError(USAGE, 2);
      }
      if (step !== "issue" && (values.scopes !== undefined || values.ttl !== undefined)) {
        throw new CliError(USAGE, 2);
      }
      // checked before anything is looked up, so a mistake costs no request
      const request =
        step === "issue"
          ? {
              scopes: scopesOf(
                values.scopes ??
                  (() => {
                    throw new CliError("--scopes is needed", 2);
                  })(),
              ),
              ...(values.ttl === undefined ? {} : { ttlSeconds: seconds(values.ttl) }),
            }
          : undefined;

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      const target = await resolveProject(ctx, apiUrl, client, values);
      const leases = client
        .organizations({ orgId: target.orgId })
        .projects({ projectId: target.projectId }).leases;

      if (step === "issue" && request) {
        const { value, ...lease } = await call(apiUrl, () =>
          leases.post(request as Parameters<typeof leases.post>[0]),
        );
        if (ctx.json) {
          ctx.io.out(JSON.stringify({ target: target.label, ...lease, value }));
        } else {
          // the token alone on stdout, so `$(orch lease issue ...)` is the token; the rest is for the person
          ctx.io.out(value);
          ctx.io.err(
            `lease ${lease.id} for ${target.label}: ${lease.scopes.join(", ")}, ends ${iso(lease.expiresAt)}`,
          );
        }
      } else if (step === "list") {
        const all = await every(apiUrl, (cursor) => leases.get({ query: { limit: 100, cursor } }));
        const lines = all.map(
          (l) =>
            `${l.id}  ${l.principal}  ${l.scopes.join(",")}  ${
              l.revokedAt ? `ended ${iso(l.revokedAt)}` : `ends ${iso(l.expiresAt)}`
            }`,
        );
        say(ctx, lines.length > 0 ? lines.join("\n") : `no leases in ${target.label}`, {
          target: target.label,
          leases: all,
        });
      } else if (id) {
        await call(apiUrl, () => leases({ leaseId: id }).delete());
        say(ctx, `revoked lease ${id} in ${target.label}`, {
          target: target.label,
          revoked: id,
        });
      }
    },
  },
});
