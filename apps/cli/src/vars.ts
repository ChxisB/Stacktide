import { open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { address, isFolderPath, ROOT, splitAddress } from "@orch/core";
import { call, session } from "./api";
import { CliError, type Command, type Context, noExtra, parse, say } from "./cli";
import { FORMATS, type Format, formatVariables } from "./format";
import { resolveEnvironment, resolveProject, type TargetFlags } from "./target";

const targetOptions = {
  "api-url": { type: "string" },
  org: { type: "string" },
  project: { type: "string" },
  env: { type: "string" },
  folder: { type: "string" },
} as const;

const SHOWN = 10;

/**
 * The folder `--folder` names, the root when it is left out. An environment variable is flat, so a
 * command reads one folder at a time and never its subfolders.
 */
function folderOf(given: string | undefined): string {
  if (given === undefined) return ROOT;
  if (!isFolderPath(given)) {
    throw new CliError(
      `--folder '${given}' is not a folder path: / or one such as /payments/db (lower-case letters, digits, - and _)`,
      2,
    );
  }
  return given;
}

/** `acme/web/prod`, or `acme/web/prod:/payments` for a folder: how a message names what it read or wrote. */
const whereIs = (label: string, folder: string) => (folder === ROOT ? label : `${label}:${folder}`);

const oneOf = <T extends string>(what: string, given: string, allowed: readonly T[]): T => {
  const hit = allowed.find((a) => a === given);
  if (!hit) throw new CliError(`unknown ${what} '${given}'; use ${allowed.join(", ")}`, 2);
  return hit;
};

type EnvironmentFlags = TargetFlags & {
  "api-url"?: string | undefined;
  folder?: string | undefined;
  "ignore-issues"?: boolean | undefined;
};

/**
 * The environment's resolved variables, of one folder (`--folder`, the root without it), with their
 * values (secrets included), as `key`/`value` pairs. A set that does not resolve (a missing reference, a cycle) is an error naming the keys, since
 * a half-resolved environment run against production is worse than none; `ignoreIssues` takes what
 * resolved and says on stderr what was left out. Shared by `pull`, `export` and `run`.
 */
export async function loadEnvironment(ctx: Context, flags: EnvironmentFlags) {
  const folder = folderOf(flags.folder);
  const { apiUrl, client } = await session(ctx, flags["api-url"]);
  const target = await resolveEnvironment(ctx, apiUrl, client, flags);
  const { variables, issues } = await call(apiUrl, () =>
    client
      .organizations({ orgId: target.orgId })
      .projects({ projectId: target.projectId })
      .environments({ envId: target.envId })
      ["resolved-variables"].values.get({ query: { folder } }),
  );
  if (issues.length > 0) {
    const list = issues.map((i) => `${i.code} ${i.key}`);
    const shown = `${list.slice(0, SHOWN).join(", ")}${list.length > SHOWN ? ", ..." : ""}`;
    if (!flags["ignore-issues"]) {
      throw new CliError(
        `${whereIs(target.label, folder)} does not resolve (${shown}); fix them, or pass --ignore-issues to take the rest`,
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
    "write an environment's resolved variables to stdout or --out <file> (dotenv, json, shell); one folder at a time: --folder <path>, default /",
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
    "print an environment's resolved variables as shell 'export' lines: eval \"$(orch export)\"; one folder at a time: --folder <path>, default /",
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
        folder: string;
      }) => Promise<{
        data: {
          changes: {
            change: "create" | "update" | "unchanged" | "conflict" | "kind_mismatch";
            key: string;
            folder?: string;
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
    "import variables from a .env or JSON file (or - for stdin) into an environment, after a preview; into one folder: --folder <path>, default /",
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
    const folder = folderOf(values.folder);

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
    const where = whereIs(target.label, folder);
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
          folder,
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
          `${c.change.padEnd(14)}${c.folder ? address(c.folder, c.key) : c.key} (${c.kind})${why[c.change] ? ` ${why[c.change]}` : ""}`,
        );
      }
      for (const s of plan.skipped) {
        ctx.io.out(
          `skipped       ${s.reason}${s.key ? ` ${s.key}` : ""}${s.line ? ` (line ${s.line})` : ""}`,
        );
      }
      ctx.io.out(`${where}: ${summary}`);
    }
    const doc = (applied: boolean, done = plan) => ({
      environment: target.label,
      ...(folder !== ROOT && { folder }),
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
    if (!values.yes && !(await ctx.confirm(`Apply ${writes.length} changes to ${where}?`))) {
      throw new CliError("cancelled; nothing was changed");
    }

    const done = await send(false);
    const created = done.changes.filter((c) => c.change === "create" && c.applied).length;
    const updated = done.changes.filter((c) => c.change === "update" && c.applied).length;
    say(ctx, `${where}: ${created} created, ${updated} updated`, doc(true, done));
  },
};

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** What `orch` holds for itself: the token it calls the API with, and the id_token that gets one. */
const WITHHELD = ["ORCH_TOKEN", "ORCH_ID_TOKEN"];
/** What `--prefix` may be: the start of an environment variable name (Terraform reads `TF_VAR_<name>`). */
const PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const runCommand: Command = {
  summary:
    "run a command with an environment's variables, kept off disk, exiting as it does (126/127 if it cannot start); --prefix TF_VAR_ names each TF_VAR_<name>; one folder at a time: --folder <path>, default /: orch run [options] -- <command> [args]",
  async run(ctx, args) {
    const usage = () => new CliError("usage: orch run [options] -- <command> [args...]", 2);
    // the command and its words are everything after the first `--`, so none of them is ours
    const split = args.indexOf("--");
    if (split === -1) throw usage();
    const { values, positionals } = parse(args.slice(0, split), {
      ...targetOptions,
      "ignore-issues": { type: "boolean" },
      prefix: { type: "string" },
    });
    noExtra(positionals);
    const [command, ...rest] = args.slice(split + 1);
    if (!command) throw usage();
    const prefix = values.prefix ?? "";
    if (values.prefix !== undefined && !PREFIX.test(prefix)) {
      throw new CliError(
        "--prefix must start an environment variable name: letters, digits and _, not starting with a digit, at most 64",
        2,
      );
    }

    const { pairs } = await loadEnvironment(ctx, values);
    const nul = pairs.find((p) => p.value.includes("\0"));
    if (nul)
      throw new CliError(`${nul.key} holds a NUL character, which an environment cannot carry`);
    // fromEntries, not assignment: a variable called `__proto__` must stay a variable. The token that
    // fetched them is not handed on: a command (and what it runs) has no need to call the API as the user.
    // Nor is the job's id_token, which can be traded for a new token until it expires. shortcut: only the
    // default name, not one given to `orch ci login --id-token-env`; upgrade if that gets common.
    const env = Object.fromEntries([
      ...Object.entries(ctx.env).filter(([name]) => !WITHHELD.includes(name)),
      ...pairs.map(({ key, value }) => [`${prefix}${key}`, value] as const),
    ]);

    // Installed before the spawn: with no handler a SIGTERM kills orch and leaves the command running.
    // Handlers run on a later turn of the event loop, by when the (synchronous) spawn has finished.
    let child: Bun.Subprocess | undefined;
    // shortcut: in a terminal Ctrl-C reaches the child itself and is passed on once more here; upgrade
    // if a program is found that takes the second SIGINT as "stop now"
    const relays = FORWARDED.map((signal) => [signal, () => child?.kill(signal)] as const);
    for (const [signal, relay] of relays) process.on(signal, relay);
    try {
      try {
        child = Bun.spawn([command, ...rest], {
          cwd: ctx.cwd,
          env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new CliError(`cannot run '${command}': not found`, 127);
        if (code === "EACCES") throw new CliError(`cannot run '${command}': not permitted`, 126);
        throw new CliError(`cannot run '${command}'`);
      }
      // a child that dies of a signal ends as 128 + the signal, like a shell reports it
      return await child.exited;
    } finally {
      for (const [signal, relay] of relays) process.off(signal, relay);
    }
  },
};

const FOLDERS_USAGE =
  "usage: orch folders list [options] | orch folders create <path> [options] | orch folders rm <path> [options]";

const folders: Command = {
  summary:
    "a project's variable folders: orch folders list|create|rm (an environment variable is flat, so pull, export, run and push read or write one folder at a time: --folder)",
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      "api-url": { type: "string" },
      org: { type: "string" },
      project: { type: "string" },
    });
    const [step, path, ...extra] = positionals;
    if (
      (step !== "list" && step !== "create" && step !== "rm") ||
      extra.length > 0 ||
      (step === "list") !== (path === undefined)
    ) {
      throw new CliError(FOLDERS_USAGE, 2);
    }
    // the root is no folder: it is not made and cannot be removed
    if (path !== undefined && (path === ROOT || !isFolderPath(path))) {
      throw new CliError(`'${path}' is not a folder path such as /payments or /payments/db`, 2);
    }

    const { apiUrl, client } = await session(ctx, values["api-url"]);
    const target = await resolveProject(ctx, apiUrl, client, values);
    const scope = client
      .organizations({ orgId: target.orgId })
      .projects({ projectId: target.projectId }).folders;
    const all = () => call(apiUrl, () => scope.get()).then((page) => page.items);

    if (step === "list") {
      const found = (await all()).map(({ id, path }) => ({ id, path }));
      const lines = found.map((f) => f.path);
      say(ctx, lines.length > 0 ? lines.join("\n") : `no folders in ${target.label}`, {
        project: target.label,
        folders: found,
      });
    } else if (step === "create" && path) {
      const { folder: parent, key: name } = splitAddress(path);
      const made = await call(apiUrl, () => scope.post({ parent, name }));
      say(ctx, `created folder ${made.path} in ${target.label}`, {
        project: target.label,
        folder: { id: made.id, path: made.path },
      });
    } else if (path) {
      const known = await all();
      const hit = known.find((f) => f.path === path);
      if (!hit) {
        const paths = known.map((f) => f.path);
        throw new CliError(
          `no folder '${path}'${
            paths.length === 0
              ? ""
              : `; known: ${paths.slice(0, SHOWN).join(", ")}${paths.length > SHOWN ? ", ..." : ""}`
          }`,
          2,
        );
      }
      await call(apiUrl, () => scope({ folderId: hit.id }).delete());
      say(ctx, `removed folder ${path} from ${target.label}`, {
        project: target.label,
        removed: path,
      });
    }
  },
};

export const varsCommands = (): Record<string, Command> => ({
  pull,
  export: exportCommand,
  push,
  run: runCommand,
  folders,
});
