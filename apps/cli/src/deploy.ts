import { statsLine } from "@orch/core";
import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { resolveProject } from "./target";

const USAGE =
  "usage: orch deploy status [--env <environment>] [--stats] | promote <environment> [--sha <sha>] [--dry-run] [--yes] | rollback <environment> [--dry-run] [--yes] | approve|reject <environment> <request-id> [options]";

/** A ref or a name is whatever GitLab holds: a control character in one must not reach someone else's terminal. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

interface Build {
  sha: string;
  ref: string;
  status: string;
  finishedAt: string | null;
  observedAt: string;
}
const build = (b: Build | null) =>
  b
    ? `${b.sha.slice(0, 8)} ${plain(b.ref)} ${plain(b.status)} ${new Date(b.finishedAt ?? b.observedAt).toISOString()}`
    : "-";

const short = (sha: string) => sha.slice(0, 8);

const unknownEnvironment = (name: string, known: string[]) =>
  new CliError(`no environment '${plain(name)}'; known: ${known.map(plain).join(", ")}`, 2);

/** What the API answers to a promotion or a rollback, a dry run too. */
interface Answer {
  dryRun: boolean;
  plan: {
    environment: string;
    from: { sha: string } | null;
    to: string;
    previous: string | null;
    defaultBranch: string;
    protected: boolean;
  };
  pipeline: { id: number; webUrl: string } | null;
}

const planLines = (step: "promote" | "rollback", label: string, p: Answer["plan"]) => [
  `${step === "promote" ? "promote to" : "roll back"} ${plain(p.environment)} (${label}): ${p.from ? short(p.from.sha) : "nothing is deployed there yet"} -> ${short(p.to)}`,
  `a pipeline on ${plain(p.defaultBranch)} deploys it`,
  ...(p.protected
    ? ["protected: starting needs an approval from someone other than the person who asks"]
    : []),
  ...(p.previous
    ? [`if a health check is set up and fails, ${short(p.previous)} is put back`]
    : []),
  ...(step === "rollback"
    ? ["data changes are not undone: a database migration that ran stays run"]
    : []),
];

export const deployCommands = (): Record<string, Command> => ({
  deploy: {
    summary:
      "what is deployed where, and start a deployment or a rollback: orch deploy status|promote|rollback",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        // only what is asked for narrows: an environment in .orch.json is where variables are read, not where to look
        env: { type: "string" },
        sha: { type: "string" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean" },
        stats: { type: "boolean" },
      });
      const [step, environment, ...extra] = positionals;
      const reading =
        step === "status" &&
        environment === undefined &&
        values.sha === undefined &&
        !values["dry-run"] &&
        !values.yes;
      // `--stats` is for status alone: the other words refuse it as they refuse any flag that is not theirs
      const writing =
        (step === "promote" || step === "rollback") &&
        environment !== undefined &&
        extra.length === 0 &&
        values.env === undefined &&
        !values.stats &&
        (step === "promote" || values.sha === undefined);
      const deciding =
        (step === "approve" || step === "reject") &&
        environment !== undefined &&
        extra.length === 1 &&
        values.env === undefined &&
        values.sha === undefined &&
        !values.stats &&
        !values["dry-run"] &&
        !values.yes;
      if (!reading && !writing && !deciding) throw new CliError(USAGE, 2);

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      const target = await resolveProject(ctx, apiUrl, client, values);
      const scope = client
        .organizations({ orgId: target.orgId })
        .projects({ projectId: target.projectId }).deployments;
      const answer = await call(apiUrl, () => scope.environments.get());
      const known = answer.environments.map((e) => e.slug);
      /** The change requests of an environment: where a protected one is entered with an approval. */
      const requestsOf = (envId: string) =>
        client
          .organizations({ orgId: target.orgId })
          .projects({ projectId: target.projectId })
          .environments({ envId })["change-requests"];

      if (deciding) {
        const env = answer.environments.find((e) => e.slug === environment);
        if (!env) throw unknownEnvironment(environment as string, known);
        const one = requestsOf(env.id)({ crId: extra[0] as string });
        const how = step === "approve" ? "approved" : "rejected";
        const done = await call(apiUrl, () =>
          step === "approve" ? one.approve.post() : one.reject.post(),
        );
        const sha = typeof done.subject?.sha === "string" ? done.subject.sha : undefined;
        say(
          ctx,
          `${how} request ${done.id}${sha ? ` to deploy ${short(sha)} to ${plain(env.slug)}` : ""}`,
          {
            project: target.label,
            request: { id: done.id, status: done.status, sha, environment: env.slug },
          },
        );
        return;
      }

      if (writing) {
        // `writing` holds only when both are there; the narrowing above does not reach this far
        const name = environment as string;
        const kind = step as "promote" | "rollback";
        let sha = values.sha;
        if (kind === "promote" && sha === undefined) {
          // the build to default to is what the environment before this one has now
          const at = known.indexOf(name);
          if (at < 0) throw unknownEnvironment(name, known);
          const before = answer.environments[at - 1];
          if (!before)
            throw new CliError(`no environment comes before ${plain(name)}; give --sha`, 2);
          if (!before.current)
            throw new CliError(`nothing is deployed to ${plain(before.slug)}; give --sha`, 2);
          sha = before.current.sha;
        }
        const send = (dryRun: boolean): Promise<Answer> =>
          call(apiUrl, () =>
            kind === "promote"
              ? scope.promote.post({ environment: name, sha: sha as string, dryRun })
              : scope.rollback.post({ environment: name, dryRun }),
          );
        const dry = values["dry-run"] === true;
        const env = answer.environments.find((e) => e.slug === name);
        // a protected environment is entered with an approval: the plan is read first even with --yes
        const guarded = env?.protected === true && !dry;
        // without --yes the plan is read first (a dry run) and shown before it is asked; with it, one call
        let shown = false;
        if (!dry && (!values.yes || guarded)) {
          const planned = await send(true);
          if (!ctx.json) ctx.io.out(planLines(kind, target.label, planned.plan).join("\n"));
          shown = true;
          if (guarded && env) {
            const now = Date.now();
            const held = await call(apiUrl, () =>
              requestsOf(env.id).get({ query: { status: "approved", limit: 100 } }),
            );
            const approved = held.items.some(
              (r) =>
                r.kind === "deploy" &&
                r.subject?.sha === planned.plan.to &&
                Date.parse(r.expiresAt) > now,
            );
            if (!approved) {
              const ask = `Ask for approval to ${kind === "promote" ? "deploy" : "roll back to"} ${short(planned.plan.to)} in ${plain(name)} of ${target.label}?`;
              if (!values.yes && !(await ctx.confirm(ask)))
                throw new CliError("cancelled; nothing was asked");
              const made = await call(apiUrl, () =>
                requestsOf(env.id).post({ kind: "deploy", sha: planned.plan.to }),
              );
              say(
                ctx,
                [
                  `asked for approval: request ${made.id}, to ${kind === "promote" ? "deploy" : "roll back to"} ${short(planned.plan.to)} in ${plain(name)}`,
                  `someone other than you approves it: orch deploy approve ${plain(name)} ${made.id}`,
                  "then run this command again to start it",
                ].join("\n"),
                {
                  project: target.label,
                  asked: { id: made.id, environment: name, sha: planned.plan.to },
                },
              );
              return;
            }
          }
          if (!values.yes) {
            const question = `Start the ${kind === "promote" ? "deployment of" : "rollback to"} ${short(planned.plan.to)} in ${plain(name)} of ${target.label}?`;
            if (!(await ctx.confirm(question)))
              throw new CliError("cancelled; nothing was started");
          }
        }
        const done = await send(dry);
        const lines = [
          ...(shown ? [] : planLines(kind, target.label, done.plan)),
          done.pipeline
            ? `pipeline ${done.pipeline.id} started: ${plain(done.pipeline.webUrl)}`
            : "dry run: nothing was started",
        ];
        say(ctx, lines.join("\n"), { project: target.label, ...done });
        return;
      }

      if (values.env !== undefined && !known.includes(values.env)) {
        throw unknownEnvironment(values.env, known);
      }
      const shown = answer.environments.filter(
        (e) => values.env === undefined || e.slug === values.env,
      );
      // the names GitLab has that this project does not belong to no one environment: left out when one was asked for
      const unmatched = values.env === undefined ? answer.unmatched : [];
      // the numbers are asked for only when wanted: a status read is one call more with the flag, and none without
      const numbers = values.stats
        ? await call(apiUrl, () => scope.stats.get({ query: { days: 30 } }))
        : undefined;
      const lines = shown.map((e) => {
        const last = e.lastAttempt && e.lastAttempt.id !== e.current?.id ? e.lastAttempt : null;
        const mine = numbers?.environments.find((n) => n.environment === e.slug);
        return `${plain(e.slug)}  current ${build(e.current)}${last ? `  last ${build(last)}` : ""}${numbers ? `  numbers ${statsLine(mine)}` : ""}`;
      });
      if (unmatched.length > 0) {
        lines.push(`in GitLab and not environments here: ${unmatched.map(plain).join(", ")}`);
      }
      say(ctx, lines.length > 0 ? lines.join("\n") : `no environments in ${target.label}`, {
        project: target.label,
        environments: shown,
        unmatched,
        ...(numbers
          ? {
              stats: {
                days: numbers.days,
                environments: numbers.environments.filter((n) =>
                  shown.some((e) => e.slug === n.environment),
                ),
              },
            }
          : {}),
      });
    },
  },
});
