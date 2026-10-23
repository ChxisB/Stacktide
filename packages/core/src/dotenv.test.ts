import { describe, expect, test } from "bun:test";
import { dotenvLine } from "./dotenv";
import { parseDotenv } from "./variable-files";

// The writer lives beside the reader (the CLI and the web share it): what it writes, the reader reads back.

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
  '"q"',
  "'\"",
  "$HOME",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a value that looks like an interpolation is the point
  "${X}",
  "`cmd`",
  "back\\slash",
  "a\\nb",
  '\\"',
  "line1\nline2",
  "crlf\r\nx",
  "trailing nl\n",
  "ünïcode ✓ 😀",
  `it's "both"\n$HOME\\n\`x\``,
];

describe("dotenvLine", () => {
  test("every value reads back exactly as written, one line each", () => {
    const pairs = values.map((value, i) => ({ key: `K${i}`, value }));
    const parsed = parseDotenv(pairs.map(dotenvLine).join("\n"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toEqual(pairs);
  });

  test("quotes only as much as the value needs", () => {
    const line = (value: string) => dotenvLine({ key: "K", value });
    expect(line("abc/1.2-x")).toBe("K=abc/1.2-x");
    expect(line("")).toBe("K=");
    expect(line("a b")).toBe("K='a b'");
    expect(line("$HOME")).toBe("K='$HOME'");
    expect(line("it's")).toBe(`K="it's"`);
    expect(line("a\nb")).toBe(`K="a\\nb"`);
  });
});
