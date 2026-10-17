import { describe, expect, test } from "bun:test";
import { CliError, type Command, type Context, parse, runCli } from "./cli";

const run = async (argv: string[], commands: Record<string, Command> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: {},
    cwd: "/work",
    home: "/home/me",
    stdin: async () => "",
    open: async () => {},
    version: "1.2.3",
    commands,
  });
  return { code, out, err };
};

describe("orch routing", () => {
  test("--version and -v print the version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, out: ["1.2.3"], err: [] });
    expect((await run(["-v"])).out).toEqual(["1.2.3"]);
  });

  test("--json turns the version into a document, wherever it stands", async () => {
    expect((await run(["--json", "--version"])).out).toEqual(['{"version":"1.2.3"}']);
    expect((await run(["--version", "--json"])).out).toEqual(['{"version":"1.2.3"}']);
  });

  test("no command and --help print the commands, sorted, with their summaries", async () => {
    const commands = {
      whoami: { summary: "show who you are", run: () => {} },
      login: { summary: "sign in", run: () => {} },
    };
    const text = (await run([], commands)).out.join("\n");
    expect(text).toContain("usage: orch");
    expect(text.indexOf("login")).toBeLessThan(text.indexOf("whoami"));
    expect(text).toContain("sign in");
    expect(await run(["--help"], commands)).toMatchObject({ code: 0 });
    expect((await run(["-h"], commands)).out.join("\n")).toBe(text);
  });

  test("an unknown command or option is a usage error (exit 2) on stderr", async () => {
    expect(await run(["nope"])).toEqual({
      code: 2,
      out: [],
      err: ["error: unknown command 'nope'; run 'orch --help'"],
    });
    expect((await run(["--nope"])).err).toEqual([
      "error: unknown option --nope; run 'orch --help'",
    ]);
    expect((await run(["--json", "nope"])).err).toEqual([
      "{\"error\":\"unknown command 'nope'; run 'orch --help'\"}",
    ]);
  });

  test("what an unexpected error says is not printed: it may hold a URL, a path or a token", async () => {
    const commands = {
      crash: {
        summary: "",
        run: () => {
          throw new TypeError("fetch failed: https://orch.example/?token=orch-secret-0123");
        },
      },
    };
    const { err } = await run(["crash"], commands);
    expect(err).toEqual(["error: unexpected error (TypeError)"]);
  });

  test("words after a leading -- with no command are a usage error, not dropped", async () => {
    expect(await run(["--", "make"])).toEqual({
      code: 2,
      out: [],
      err: ["error: expected a command before --; run 'orch --help'"],
    });
    expect(await run(["--json", "--", "make"])).toMatchObject({ code: 2 });
  });

  test("names on the prototype are not commands", async () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(await run([name])).toMatchObject({ code: 2 });
  });

  test("a command gets the words after its name, the context, and its error becomes the exit code", async () => {
    let seen: { args: string[]; ctx: Pick<Context, "env" | "cwd" | "home" | "json"> } | undefined;
    const commands = {
      echo: {
        summary: "",
        run: (ctx: Context, args: string[]) => {
          seen = { args, ctx: { env: ctx.env, cwd: ctx.cwd, home: ctx.home, json: ctx.json } };
        },
      },
      boom: {
        summary: "",
        run: () => {
          throw new CliError("no good", 3);
        },
      },
      crash: {
        summary: "",
        run: () => {
          throw new Error("disk on fire");
        },
      },
    };
    expect((await run(["echo", "a", "--b", "c"], commands)).code).toBe(0);
    expect(seen).toEqual({
      args: ["a", "--b", "c"],
      ctx: { env: {}, cwd: "/work", home: "/home/me", json: false },
    });
    expect(await run(["boom"], commands)).toEqual({ code: 3, out: [], err: ["error: no good"] });
    expect(await run(["crash"], commands)).toEqual({
      code: 1,
      out: [],
      err: ["error: unexpected error (Error)"],
    });
    expect((await run(["--json", "boom"], commands)).err).toEqual(['{"error":"no good"}']);
  });

  test("--json is global before a --, and belongs to the command after it", async () => {
    let args: string[] = [];
    let json = false;
    const commands = {
      run: {
        summary: "",
        run: (ctx: Context, a: string[]) => {
          args = a;
          json = ctx.json;
        },
      },
    };
    await run(["run", "--json", "--", "make", "--json", "x"], commands);
    expect({ args, json }).toEqual({ args: ["--", "make", "--json", "x"], json: true });
    await run(["run", "--", "make", "--json"], commands);
    expect({ args, json }).toEqual({ args: ["--", "make", "--json"], json: false });
  });
});

describe("a command's options", () => {
  test("parse reads options and positionals, and an unknown option is a usage error", () => {
    const options = { yes: { type: "boolean", short: "y" }, format: { type: "string" } } as const;
    const { values, positionals } = parse(["a", "--format", "json", "-y", "b"], options);
    expect({ values, positionals }).toEqual({
      values: { format: "json", yes: true },
      positionals: ["a", "b"],
    });
    const error = (() => {
      try {
        parse(["--nope"], options);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(() => parse(["--format"], options)).toThrow(CliError);
  });
});
