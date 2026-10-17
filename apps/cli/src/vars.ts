import { open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { call, clientFor, resolveApi } from "./api";
import { CliError, type Command, type Context, parse, say } from "./cli";
import { FORMATS, type Format, formatVariables } from "./format";
import { resolveEnvironment, type TargetFlags } from "./target";

const targetOptions = {
  "api-url": { type: "string" },
  org: { type: "string" },
  project: { type: "string" },
  env: { type: "string" },
} as const;

const SHOWN = 10;

const oneOf = <T extends string>(what: string, given: string, allowed: readonly T[]): T => {
  const hit = allowed.find((a) => a === given);
  if (!hit) throw new CliError(`unknown ${what} '${given}'; use ${allowed.join(", ")}`, 2);
  return hit;
};
const noExtra = (positionals: string[]) => {
  if (positionals.length > 0) throw new CliError("unexpected argument; run 'orch --help'", 2);
};

async function session(ctx: Context, flag: string | undefined) {
  const { apiUrl, token } = await resolveApi(ctx, flag);
  if (!token) throw new CliError("not signed in; run: orch login");
  return { apiUrl, client: clientFor(apiUrl, token) };
}

type EnvironmentFlags = TargetFlags & {
  "api-url"?: string | undefined;
  "ignore-issues"?: boolean | undefined;
};

/**
 * The environment's resolved variables with their values (secrets included), as `key`/`value`
 * pairs. A set that does not resolve (a missing reference, a cycle) is an error naming the keys, since
 * a half-resolved environment run against production is worse than none; `ignoreIssues` takes what
 * resolved and says on stderr what was left out. Shared by `pull`, `export` and `run`.
 */
export async function loadEnvironment(ctx: Context, flags: EnvironmentFlags) {
  const { apiUrl, client } = await session(ctx, flags["api-url"]);
  const target = await resolveEnvironment(ctx, apiUrl, client, flags);
  const { variables, issues } = await call(apiUrl, () =>
    client
      .organizations({ orgId: target.orgId })
      .projects({ projectId: target.projectId })
      .environments({ envId: target.envId })
      ["resolved-variables"].values.get(),
  );
  if (issues.length > 0) {
    const list = issues.map((i) => `${i.code} ${i.key}`);
    const shown = `${list.slice(0, SHOWN).join(", ")}${list.length > SHOWN ? ", ..." : ""}`;
    if (!flags["ignore-issues"]) {
      throw new CliError(
        `${target.label} does not resolve (${shown}); fix them, or pass --ignore-issues to take the rest`,
      );
    }
    ctx.io.err(`warning: left out ${issues.length} that do not resolve (${shown})`);
  }
  return { target, pairs: variables.map(({ key, value }) => ({ key, value })) };
}

/**
 * Writes `data` to a new file readable by this user only. Without `force` an existing file (a link
 * too) is refused; with it the file is replaced through a temporary one, so the new file has the
 * right mode whatever the old one had and a link at `path` is replaced, never written through.
 */
async function writePrivate(path: string, data: string, shown: string, force: boolean) {
  const tmp = force ? `${path}.${process.pid}.tmp` : path;
  if (force) await rm(tmp, { force: true });
  let made = false;
  try {
    const file = await open(tmp, "wx", 0o600);
    made = true;
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    if (force) await rename(tmp, path);
  } catch (e) {
    if (made) await rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`${shown} exists; pass --force to replace it`);
    }
    throw new CliError(`cannot write ${shown}`);
  }
}

const exportOptions = {
  ...targetOptions,
  format: { type: "string" },
  "ignore-issues": { type: "boolean" },
} as const;

async function emit(
  ctx: Context,
  values: EnvironmentFlags & { format?: string | undefined },
  defaultFormat: Format,
  out?: { path: string; force: boolean },
) {
  const format = values.format
    ? oneOf("format", values.format, FORMATS)
    : ctx.json && !out
      ? "json"
      : defaultFormat;
  const { pairs } = await loadEnvironment(ctx, values);
  const text = formatVariables(pairs, format);
  if (!out) {
    if (text) ctx.io.out(text);
    return;
  }
  await writePrivate(resolve(ctx.cwd, out.path), text && `${text}\n`, out.path, out.force);
  say(ctx, `wrote ${pairs.length} variables to ${out.path}`, {
    file: out.path,
    count: pairs.length,
  });
}

const pull: Command = {
  summary:
    "write an environment's resolved variables to stdout or --out <file> (dotenv, json, shell)",
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      ...exportOptions,
      out: { type: "string" },
      force: { type: "boolean" },
    });
    noExtra(positionals);
    const { out, force } = values;
    await emit(
      ctx,
      values,
      "dotenv",
      out === undefined ? undefined : { path: out, force: !!force },
    );
  },
};

const exportCommand: Command = {
  summary:
    "print an environment's resolved variables as shell 'export' lines: eval \"$(orch export)\"",
  async run(ctx, args) {
    const { values, positionals } = parse(args, exportOptions);
    noExtra(positionals);
    await emit(ctx, values, "shell");
  },
};

const MIB = 1024 * 1024;

/**
 * What `push` relies on of the import route. shortcut: the variable routes are built from a prefix
 * known only at run time, so the typed client cannot see them; this shape is held to the API by the
 * end-to-end tests. Upgrade by giving the routes literal prefixes (the web UI will want it too).
 */
interface ImportScope {
  variables: {
    import: {
      post: (body: {
        source: "dotenv" | "json";
        content: string;
        kind: "plain" | "secret";
        overwrite: boolean;
        dryRun: boolean;
      }) => Promise<{
        data: {
          changes: {
            change: "create" | "update" | "unchanged" | "conflict" | "kind_mismatch";
            key: string;
            kind: string;
            applied: boolean;
          }[];
          skipped: { reason: string; key?: string; line?: number }[];
        } | null;
        error: unknown;
        status: number;
      }>;
    };
  };
}

const push: Command = {
  summary:
    "import variables from a .env or JSON file (or - for stdin) into an environment, after a preview",
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      ...targetOptions,
      format: { type: "string" },
      kind: { type: "string" },
      overwrite: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
    });
    const [file, ...extra] = positionals;
    if (!file || extra.length > 0) throw new CliError("usage: orch push <file|-> [options]", 2);
    const format = oneOf("format", values.format ?? (file.endsWith(".json") ? "json" : "dotenv"), [
      "dotenv",
      "json",
    ] as const);
    const kind = oneOf("kind", values.kind ?? "secret", ["plain", "secret"] as const);

    let content: string;
    try {
      content = file === "-" ? await ctx.stdin() : await Bun.file(resolve(ctx.cwd, file)).text();
    } catch {
      throw new CliError(`cannot read ${file}`);
    }
    const source = file === "-" ? "standard input" : file;
    if (content.length === 0) throw new CliError(`${source} is empty`, 2);
    if (content.length > MIB) throw new CliError(`${source} is larger than 1 MiB`, 2);

    const { apiUrl, client } = await session(ctx, values["api-url"]);
    const target = await resolveEnvironment(ctx, apiUrl, client, values);
    const scope = client
      .organizations({ orgId: target.orgId })
      .projects({ projectId: target.projectId })
      .environments({ envId: target.envId }) as unknown as ImportScope;
    const send = (dryRun: boolean) =>
      call(apiUrl, () =>
        scope.variables.import.post({
          source: format,
          content,
          kind,
          overwrite: !!values.overwrite,
          dryRun,
        }),
      );

    const plan = await send(true);
    const writes = plan.changes.filter((c) => c.change === "create" || c.change === "update");
    const blocked = plan.changes.filter(
      (c) => c.change === "conflict" || c.change === "kind_mismatch",
    );
    const unchanged = plan.changes.filter((c) => c.change === "unchanged").length;
    const held = blocked.length + plan.skipped.length;
    const summary = `${writes.length} to write, ${unchanged} unchanged, ${blocked.length} in conflict, ${plan.skipped.length} skipped`;

    // keys and kinds only: the values in the file are not shown
    if (!ctx.json) {
      const why: Record<string, string> = {
        conflict: "holds another value; --overwrite replaces it",
        kind_mismatch: "is held with another kind, which cannot change",
      };
      for (const c of plan.changes) {
        if (c.change === "unchanged") continue;
        ctx.io.out(
          `${c.change.padEnd(14)}${c.key} (${c.kind})${why[c.change] ? ` ${why[c.change]}` : ""}`,
        );
      }
      for (const s of plan.skipped) {
        ctx.io.out(
          `skipped       ${s.reason}${s.key ? ` ${s.key}` : ""}${s.line ? ` (line ${s.line})` : ""}`,
        );
      }
      ctx.io.out(`${target.label}: ${summary}`);
    }
    const doc = (applied: boolean, done = plan) => ({
      environment: target.label,
      applied,
      changes: done.changes.map(({ change, key, kind }) => ({ change, key, kind })),
      skipped: done.skipped,
    });

    if (values["dry-run"]) {
      if (ctx.json) ctx.io.out(JSON.stringify(doc(false)));
      return;
    }
    // With --yes nobody has read the preview, so anything the file holds that cannot be applied
    // stops the push: a CI step that skips a malformed line must not report success.
    if (values.yes && held > 0) {
      throw new CliError(
        `${held} entries cannot be applied (see above); nothing was changed. Fix the file, or run without --yes to decide`,
      );
    }
    if (writes.length === 0) {
      if (ctx.json) ctx.io.out(JSON.stringify(doc(false)));
      else ctx.io.out("nothing to push");
      return;
    }
    if (!values.yes && !(await ctx.confirm(`Apply ${writes.length} changes to ${target.label}?`))) {
      throw new CliError("cancelled; nothing was changed");
    }

    const done = await send(false);
    const created = done.changes.filter((c) => c.change === "create" && c.applied).length;
    const updated = done.changes.filter((c) => c.change === "update" && c.applied).length;
    say(ctx, `${target.label}: ${created} created, ${updated} updated`, doc(true, done));
  },
};

export const varsCommands = (): Record<string, Command> => ({
  pull,
  export: exportCommand,
  push,
});
