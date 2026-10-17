import { parseArgs } from "node:util";
import type { ZodError } from "zod";

/** A failure the user can act on: printed as one line, never with a stack. `exitCode` 2 is a usage error. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface Context {
  io: Io;
  env: Record<string, string | undefined>;
  cwd: string;
  /** The user's home directory (where the config file lives by default). */
  home: string;
  /** All of standard input, for commands that take a secret from a pipe rather than the command line. */
  stdin: () => Promise<string>;
  /** Shows a URL in the user's browser; it may fail, so callers also print the URL. */
  open: (url: string) => Promise<void>;
  /** `--json`: commands print one JSON document instead of text. */
  json: boolean;
}

export interface Command {
  summary: string;
  /** `args` are what follows the command name; a `--` and what follows it are kept for `parse`. */
  run: (ctx: Context, args: string[]) => Promise<void> | void;
}

export interface CliDeps extends Pick<Context, "io" | "env" | "cwd" | "home" | "stdin" | "open"> {
  version: string;
  commands: Record<string, Command>;
}

/** The names of the fields a zod error is about (an unknown key is named by the key), never the values given. */
export const fieldsOf = (error: ZodError) =>
  error.issues
    .flatMap((i) =>
      i.code === "unrecognized_keys" ? i.keys : [i.path.length > 0 ? i.path.join(".") : "(file)"],
    )
    .join(", ");

/** `parseArgs` that is strict and fails as a usage error; text of its error holds option names only. */
export function parse<O extends NonNullable<Parameters<typeof parseArgs>[0]>["options"]>(
  args: string[],
  options: O,
) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : "invalid arguments", 2);
  }
}

const helpText = (commands: CliDeps["commands"]) => {
  const names = Object.keys(commands).sort();
  const width = Math.max(0, ...names.map((n) => n.length));
  return [
    "usage: orch [--json] <command> [options]",
    "",
    "commands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${commands[n]?.summary ?? ""}`),
    "",
    "options:",
    "  --json       print one JSON document instead of text",
    "  -v, --version",
    "  -h, --help",
  ].join("\n");
};

/**
 * Routes `orch [--json] <command> ...` and returns the exit code. `--json` is global: it is removed
 * wherever it appears before a `--` (after one, the words belong to the command, as in `run -- cmd`).
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const split = argv.indexOf("--");
  const before = split === -1 ? argv : argv.slice(0, split);
  // global, so a command option cannot take the value "--json"; write it `--option=--json`
  const json = before.includes("--json");
  const head = before.filter((a) => a !== "--json");
  const tail = split === -1 ? [] : argv.slice(split);
  const { io } = deps;
  const fail = (message: string) =>
    io.err(json ? JSON.stringify({ error: message }) : `error: ${message}`);

  const [name, ...rest] = head;
  if (name === undefined && tail.length > 0) {
    fail("expected a command before --; run 'orch --help'");
    return 2;
  }
  if (name === "--version" || name === "-v") {
    io.out(json ? JSON.stringify({ version: deps.version }) : deps.version);
    return 0;
  }
  if (name === undefined || name === "--help" || name === "-h") {
    io.out(helpText(deps.commands));
    return 0;
  }
  const command = Object.hasOwn(deps.commands, name) ? deps.commands[name] : undefined;
  if (!command) {
    fail(
      name.startsWith("-")
        ? `unknown option ${name}; run 'orch --help'`
        : `unknown command '${name}'; run 'orch --help'`,
    );
    return 2;
  }
  try {
    const { env, cwd, home, stdin, open } = deps;
    await command.run({ io, env, cwd, home, stdin, open, json }, [...rest, ...tail]);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      fail(e.message);
      return e.exitCode;
    }
    // the message of an error nobody planned for may hold a URL, a path or a token: only its kind is printed
    fail(`unexpected error (${e instanceof Error ? e.name : "unknown"})`);
    return 1;
  }
}
