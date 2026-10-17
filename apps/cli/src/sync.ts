import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, onlyOrNamed, resolveProject } from "./target";

const USAGE = "usage: orch sync plan [options] | orch sync apply <plan-id> [--yes] [options]";
const ACTIONS = ["create", "update", "delete", "adopt", "noop"] as const;

/** What this prints of a run: ids, keys, scopes, actions and the target's own words, never a value (the API holds none). */
interface Run {
  id: string;
  status: string;
  error: string | null;
  expiresAt: Date | string;
  counts: Partial<Record<string, number>>;
  skipped: {
    unresolved: { key: string; scope: string; code: string }[];
    missingEnvironments: string[];
  };
  items: {
    key: string;
    scope: string;
    action: string;
    changed: string[];
    result: string | null;
    error: string | null;
  }[];
}

/** `word` as one shell word, for a command the user may paste. */
const shellWord = (word: string) =>
  /^[\w.@:/=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const countsOf = (run: Run) => ACTIONS.map((a) => `${a} ${run.counts[a] ?? 0}`).join(", ");
const changesOf = (run: Run) => run.items.filter((i) => i.action !== "noop");

/** The plan as lines: what it would change, what it left out, and how long it can be applied for. */
function planLines(run: Run, label: string, hint?: string) {
  const changes = changesOf(run);
  const width = (pick: (i: Run["items"][number]) => string) =>
    Math.max(0, ...changes.map((i) => pick(i).length));
  const [action, key, scope] = [width((i) => i.action), width((i) => i.key), width((i) => i.scope)];
  const lines = [`sync plan ${run.id} for ${label}: ${countsOf(run)}`];
  for (const i of changes) {
    const what = i.changed.length > 0 ? `  (${i.changed.join(", ")})` : "";
    lines.push(
      `  ${i.action.padEnd(action)}  ${i.key.padEnd(key)}  ${i.scope.padEnd(scope)}${what}`.trimEnd(),
    );
  }
  const { unresolved, missingEnvironments } = run.skipped;
  const left = [
    ...unresolved.map((u) => `${u.key} ${u.scope} (${u.code})`),
    ...missingEnvironments.map((e) => `environment ${e}, mapped but gone`),
  ];
  if (left.length > 0) lines.push(`left out: ${left.join("; ")}`);
  lines.push(`expires ${new Date(run.expiresAt).toISOString()}`);
  if (hint) lines.push(hint);
  return lines;
}

/**
 * `orch sync plan` and `orch sync apply <plan-id>`: the two steps of a sync (SYNC-5, SYNC-6). A plan
 * writes nothing to the target; an apply takes a plan by its id, shows what it would change, asks
 * (`--yes` in a script), and waits for the server to finish it. `waitMs` bounds that wait, `pollMs`
 * is the first pause between looks (it doubles up to 2 s).
 */
export function syncCommands({ waitMs = 600_000, pollMs = 250 } = {}): Record<string, Command> {
  return {
    sync: {
      summary:
        "plan what a project's variables would change on a sync target, then apply that plan: orch sync plan|apply",
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          "api-url": { type: "string" },
          org: { type: "string" },
          project: { type: "string" },
          target: { type: "string" },
          yes: { type: "boolean" },
        });
        const [step, planId, ...extra] = positionals;
        const planning = step === "plan" && planId === undefined && !values.yes;
        const applying = step === "apply" && planId !== undefined && extra.length === 0;
        if (!planning && !applying) throw new CliError(USAGE, 2);

        const { apiUrl, client } = await session(ctx, values["api-url"]);
        const project = await resolveProject(ctx, apiUrl, client, values);
        const scope = client
          .organizations({ orgId: project.orgId })
          .projects({ projectId: project.projectId });
        const targetId = await onlyOrNamed("sync target", "--target", values.target, () =>
          every(apiUrl, (cursor) => scope["sync-targets"].get({ query: { limit: 100, cursor } })),
        );
        const target = scope["sync-targets"]({ targetId });
        const via = values.target === undefined ? "" : ` --target ${shellWord(values.target)}`;

        if (planning) {
          const run: Run = await call(apiUrl, () => target.plan.post());
          say(
            ctx,
            planLines(run, project.label, `apply with: orch sync apply ${run.id}${via}`).join("\n"),
            run,
          );
          return;
        }

        const id = planId as string;
        const run: Run = await call(apiUrl, () => target.runs({ runId: id }).get());
        if (run.status !== "planned") {
          throw new CliError(`plan ${id} is ${run.status}, not waiting to be applied: plan again`);
        }
        const changes = changesOf(run);
        if (!ctx.json) ctx.io.out(planLines(run, project.label).join("\n"));
        if (changes.length === 0) {
          say(ctx, "nothing to apply", { ...run, applied: false });
          return;
        }
        const deletes = changes.filter((c) => c.action === "delete").length;
        const question = `Apply ${changes.length} changes${deletes > 0 ? ` (${deletes} deletes)` : ""} to ${project.label}?`;
        if (!values.yes && !(await ctx.confirm(question))) {
          throw new CliError("cancelled; nothing was changed");
        }

        let current: Run = await call(apiUrl, () => target.apply.post({ planId: id }));
        const deadline = Date.now() + waitMs;
        let delay = pollMs;
        while (current.status === "applying") {
          const running = current.id;
          if (Date.now() >= deadline) {
            throw new CliError(
              `run ${running} is still applying after ${Math.round(waitMs / 1000)} s; it goes on without this command`,
            );
          }
          await Bun.sleep(delay);
          delay = Math.min(delay * 2, 2_000);
          // the apply is on the server's worker: a lost look at it must not read as a lost apply
          current = await call(apiUrl, () => target.runs({ runId: running }).get()).catch(
            (e: unknown) => {
              if (!(e instanceof CliError)) throw e;
              throw new CliError(
                `lost track of run ${running}: ${e.message}; it goes on without this command`,
                e.exitCode,
              );
            },
          );
        }

        const failed = current.items.filter((i) => i.result === "failed");
        const applied = current.items.filter((i) => i.result === "applied").length;
        say(
          ctx,
          `sync run ${current.id} for ${project.label}: ${current.status}, ${applied} applied, ${failed.length} failed`,
          current,
        );
        if (current.error) ctx.io.err(`error: ${current.error}`);
        for (const f of failed)
          ctx.io.err(`  failed ${f.key} ${f.scope}: ${f.error ?? "no reason given"}`);
        return current.status === "applied" ? 0 : 1;
      },
    },
  };
}
