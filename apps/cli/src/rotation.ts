import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, idOf, resolveEnvironment, resolveOrganization, resolveProject } from "./target";

const USAGE =
  "usage: orch rotation show|run|rm <KEY> [options] | orch rotation set <KEY> --provider <name> --interval <days> [--grace <days>] [--config <json>] [--disabled] [options]";
const LEVELS = ["env", "project", "org"] as const;
/** What only `set` takes: given to another step it is a mistake, not something to ignore. */
const SET_ONLY = ["provider", "interval", "grace", "config", "disabled"] as const;

/** A whole number of days, or a usage error that names the flag and not what was typed. */
function days(flag: string, raw: string | undefined, min: number) {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < min) {
    throw new CliError(`${flag} takes a whole number of days, at least ${min}`, 2);
  }
  return n;
}

/**
 * The provider's settings from `--config`: a JSON object. Settings are ids and numbers, never a secret,
 * but the text is still the user's own, so no message repeats it.
 */
function configOf(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // falls through to the same error
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--config takes a JSON object, such as '{\"length\":40}'", 2);
  }
  return parsed as Record<string, unknown>;
}

/** The typed client hands dates back as `Date`s: printed as the ISO text the API sent. */
const iso = (at: Date | string) => new Date(at).toISOString();

interface Shown {
  provider: string;
  intervalDays: number;
  graceDays: number;
  enabled: boolean;
  nextAt: Date | string;
  lastAt: Date | string | null;
  lastStatus: string;
  lastError: string | null;
  attempts: number;
  revokePending: boolean;
}

/** The rotation as lines, one fact each. Nothing here can be a secret: the API keeps the config to itself. */
function showLines(label: string, r: Shown) {
  const rows: [string, string][] = [
    ["provider", r.provider],
    ["interval", `${r.intervalDays} days${r.graceDays > 0 ? `, grace ${r.graceDays} days` : ""}`],
    ["enabled", r.enabled ? "yes" : "no"],
    ["next", iso(r.nextAt)],
    [
      "last",
      r.lastStatus === "never"
        ? "never rotated"
        : `${r.lastAt ? iso(r.lastAt) : "-"} ${r.lastStatus}${r.lastError ? ` (${r.lastError})` : ""}${r.attempts > 0 ? `, ${r.attempts} failed in a row` : ""}`,
    ],
  ];
  if (r.revokePending) rows.push(["revoke", "pending: a replaced credential is still valid"]);
  return [label, ...rows.map(([name, value]) => `${name.padEnd(9)} ${value}`)];
}

export const rotationCommands = (): Record<string, Command> => ({
  rotation: {
    summary:
      "how a secret variable rotates: orch rotation set|show|run|rm <KEY> (--level env|project|org)",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        env: { type: "string" },
        level: { type: "string" },
        provider: { type: "string" },
        interval: { type: "string" },
        grace: { type: "string" },
        config: { type: "string" },
        disabled: { type: "boolean" },
        yes: { type: "boolean" },
      });
      const [step, key, ...extra] = positionals;
      const known = step === "set" || step === "show" || step === "run" || step === "rm";
      if (!known || !key || extra.length > 0) throw new CliError(USAGE, 2);
      if (step !== "set" && SET_ONLY.some((f) => values[f] !== undefined)) {
        throw new CliError(USAGE, 2);
      }
      if (step !== "run" && values.yes) throw new CliError(USAGE, 2);
      const level = values.level ?? "env";
      if (!LEVELS.some((l) => l === level)) {
        throw new CliError(`unknown level '${level}'; use ${LEVELS.join(", ")}`, 2);
      }
      // checked before anything is looked up, so a mistake costs no request
      const setting =
        step === "set"
          ? {
              provider:
                values.provider ??
                (() => {
                  throw new CliError("--provider is needed", 2);
                })(),
              intervalDays: days("--interval", values.interval, 1),
              graceDays: values.grace === undefined ? 0 : days("--grace", values.grace, 0),
              ...(values.config === undefined ? {} : { config: configOf(values.config) }),
              enabled: !values.disabled,
            }
          : undefined;

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      // the three levels answer alike: only the path to the variables differs
      const where =
        level === "org"
          ? await resolveOrganization(ctx, apiUrl, client, values).then((o) => ({
              label: o.label,
              variables: client.organizations({ orgId: o.orgId }).variables,
            }))
          : level === "project"
            ? await resolveProject(ctx, apiUrl, client, values).then((p) => ({
                label: p.label,
                variables: client
                  .organizations({ orgId: p.orgId })
                  .projects({ projectId: p.projectId }).variables,
              }))
            : await resolveEnvironment(ctx, apiUrl, client, values).then((e) => ({
                label: e.label,
                variables: client
                  .organizations({ orgId: e.orgId })
                  .projects({ projectId: e.projectId })
                  .environments({ envId: e.envId }).variables,
              }));
      const varId = await idOf("variable", key, () =>
        every(apiUrl, (cursor) => where.variables.get({ query: { limit: 100, cursor } })).then(
          (all) => all.map((v) => ({ id: v.id, name: v.key })),
        ),
      );
      const rotation = where.variables({ varId }).rotation;
      const named = { target: where.label, key };

      if (step === "show") {
        const r = await call(apiUrl, () => rotation.get());
        say(ctx, showLines(`${where.label} ${key}`, r).join("\n"), { ...named, ...r });
      } else if (step === "set" && setting) {
        const r = await call(apiUrl, () => rotation.put(setting));
        say(
          ctx,
          `${where.label} ${key}: ${r.provider} every ${r.intervalDays} days${r.enabled ? "" : " (switched off)"}, next ${iso(r.nextAt)}`,
          { ...named, ...r },
        );
      } else if (step === "run") {
        if (!values.yes && !(await ctx.confirm(`Rotate ${key} in ${where.label} now?`))) {
          throw new CliError("cancelled; nothing was changed");
        }
        // the answer is a result, a version number or a change request: never the new value
        const r = await call(apiUrl, () => rotation.rotate.post());
        const text =
          r.result === "rotated"
            ? `rotated: ${key} in ${where.label} is now version ${r.version}`
            : r.result === "waiting"
              ? `waiting: ${key} in ${where.label}: change request ${r.changeRequestId} holds the new value`
              : `skipped: ${key} in ${where.label} (${r.why})`;
        say(ctx, text, { ...r, ...named });
      } else {
        await call(apiUrl, () => rotation.delete());
        say(ctx, `removed the rotation of ${key} in ${where.label}`, { removed: true, ...named });
      }
    },
  },
});
