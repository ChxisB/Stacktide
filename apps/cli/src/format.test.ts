import { describe, expect, test } from "bun:test";
import { parseDotenv, parseJsonVariables } from "@orch/core";
import { CliError } from "./cli";
import { formatVariables, type Pair } from "./format";

/** Values a formatter has to get right: every character a quoting rule treats as special, alone and together. */
const values = [
  "",
  "plain",
  "with space",
  " leading",
  "trailing ",
  "a=b",
  "a#b",
  "a #b",
  "#lead",
  "it's",
  "'",
  '"q"',
  "'\"",
  "$HOME",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a value that looks like an interpolation is the point
  "${X}",
  "$(echo hi)",
  "`cmd`",
  "back\\slash",
  "a\\nb",
  "\\",
  '\\"',
  "line1\nline2",
  "crlf\r\nx",
  "\r",
  "trailing nl\n",
  "\n\n",
  "tab\tx",
  "; rm -rf /",
  "ünïcode ✓ 😀",
  `it's "both"\n$HOME\\n\`x\``,
  "x".repeat(5000),
];
const pairs: Pair[] = values.map((value, i) => ({ key: `K${i}`, value }));

describe("dotenv", () => {
  test("every value reads back exactly as written", () => {
    const parsed = parseDotenv(formatVariables(pairs, "dotenv"));
    expect(parsed.issues).toEqual([]);
    expect(new Map(parsed.entries.map((e) => [e.key, e.value]))).toEqual(
      new Map(pairs.map((e) => [e.key, e.value])),
    );
  });

  test("quotes only as much as the value needs", () => {
    const line = (value: string) => formatVariables([{ key: "K", value }], "dotenv");
    expect(line("abc/1.2-x")).toBe("K=abc/1.2-x");
    expect(line("")).toBe("K=");
    expect(line("a b")).toBe("K='a b'");
    expect(line("$HOME")).toBe("K='$HOME'");
    expect(line("it's")).toBe(`K="it's"`);
    expect(line("a\nb")).toBe(`K="a\\nb"`);
    expect(line("a\rb")).toBe(`K="a\\rb"`);
    expect(line(`say "x" 'y'`)).toBe(`K="say \\"x\\" 'y'"`);
    expect(line("c:\\x'")).toBe(`K="c:\\\\x'"`);
  });
});

describe("shell", () => {
  test("a real shell reads every value back exactly", async () => {
    const script = `${formatVariables(pairs, "shell")}\nexec "$0" -e 'process.stdout.write(JSON.stringify(process.env))'`;
    const proc = Bun.spawn(["sh", "-c", script, process.execPath], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const env = JSON.parse(out) as Record<string, string>;
    for (const { key, value } of pairs) expect(env[key]).toBe(value);
  });

  test("single quotes are closed, escaped and reopened", () => {
    expect(formatVariables([{ key: "K", value: "it's" }], "shell")).toBe(`export K='it'\\''s'`);
    expect(formatVariables([{ key: "K", value: "" }], "shell")).toBe("export K=''");
  });
});

describe("json", () => {
  test("every value reads back exactly, and a key called __proto__ stays a key", () => {
    const all = [...pairs, { key: "__proto__", value: "p" }];
    const text = formatVariables(all, "json");
    const parsed = parseJsonVariables(text);
    expect(parsed.issues).toEqual([]);
    expect(new Map(parsed.entries.map((e) => [e.key, e.value]))).toEqual(
      new Map(all.map((e) => [e.key, e.value])),
    );
    expect(text.startsWith("{\n")).toBe(true);
  });
});

describe("all formats", () => {
  test("output is sorted by key, whatever order it came in", () => {
    const unsorted = [
      { key: "B", value: "2" },
      { key: "A", value: "1" },
      { key: "C", value: "3" },
    ];
    expect(formatVariables(unsorted, "dotenv")).toBe("A=1\nB=2\nC=3");
    expect(formatVariables(unsorted, "shell")).toBe("export A='1'\nexport B='2'\nexport C='3'");
    expect(Object.keys(JSON.parse(formatVariables(unsorted, "json")))).toEqual(["A", "B", "C"]);
  });

  test("nothing at all is an empty document", () => {
    expect(formatVariables([], "dotenv")).toBe("");
    expect(formatVariables([], "shell")).toBe("");
    expect(formatVariables([], "json")).toBe("{}");
  });

  test("a name that is not a variable name is refused in every format, and not repeated", () => {
    for (const key of [
      "X; touch /tmp/owned",
      "A B",
      "1A",
      "",
      "A=B",
      "$(id)",
      "A\nB",
      "x".repeat(256),
    ]) {
      for (const f of ["dotenv", "json", "shell"] as const) {
        let error: unknown;
        try {
          formatVariables([{ key, value: "v" }], f);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).message).not.toContain("touch");
      }
    }
    expect(formatVariables([{ key: "x".repeat(255), value: "v" }], "shell")).toContain("export x");
  });

  test("a NUL is refused by the formats that cannot carry it, naming the key and not the value", () => {
    const nul = [{ key: "K", value: "sekrit\0tail" }];
    for (const f of ["dotenv", "shell"] as const) {
      let error: unknown;
      try {
        formatVariables(nul, f);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("K");
      expect((error as CliError).message).not.toContain("sekrit");
    }
    expect(JSON.parse(formatVariables(nul, "json")).K).toBe("sekrit\0tail");
  });
});
