// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings under test are made of `${...}`
import { describe, expect, test } from "bun:test";
import { parseDotenv, parseJsonVariables } from "./variable-files";

const values = (text: string) =>
  Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]));
const issues = (text: string) =>
  parseDotenv(text).issues.map((i) => `${i.reason}@${i.line}${i.key ? `:${i.key}` : ""}`);

describe("parseDotenv", () => {
  test("plain assignments, comments, blank lines, export, indentation and spaces around =", () => {
    const text = [
      "# a comment",
      "",
      "A=1",
      "  B = two words ",
      "export C=3",
      "export   D = 4",
      "\t# indented comment",
      "  E=5",
      "export=6",
      "F=b=c",
      "G=abc==",
    ].join("\n");
    expect(values(text)).toEqual({
      A: "1",
      B: "two words",
      C: "3",
      D: "4",
      E: "5",
      export: "6",
      F: "b=c",
      G: "abc==",
    });
    expect(issues(text)).toEqual([]);
  });

  test("line ends: CRLF, a lone CR, a BOM and no final newline", () => {
    expect(values("\uFEFFA=1\r\nB=2\rC=3\nD=4")).toEqual({ A: "1", B: "2", C: "3", D: "4" });
  });

  test("empty values", () => {
    expect(values("A=\nB=\"\"\nC=''\nD=   \nE=# only a comment")).toEqual({
      A: "",
      B: "",
      C: "",
      D: "",
      E: "",
    });
  });

  test("a comment after an unquoted value needs whitespace before the #", () => {
    expect(
      values(
        "A=1 # note\nB=a#b\nC=http://x/y#frag\nD=1\t#tab\nE=x ## two\nF=\"q\" # after\nG='q'#glued",
      ),
    ).toEqual({ A: "1", B: "a#b", C: "http://x/y#frag", D: "1", E: "x", F: "q", G: "q" });
  });

  test("single quotes and backticks are literal", () => {
    const text = "A='a $B ${C} \\n # x'\nB=`back \"tick\" 'it'`\nC='it''s'\nD=\"it's\"";
    // 'it''s' is a value followed by more text: reported, not guessed
    expect(values(text)).toEqual({
      A: "a $B ${C} \\n # x",
      B: "back \"tick\" 'it'",
      D: "it's",
    });
    expect(issues(text)).toEqual(["syntax@3"]);
  });

  test('double quotes know \\n \\r \\t \\" and \\\\, and leave other backslashes alone', () => {
    expect(
      values('A="a\\nb\\tc\\rd"\nB="say \\"hi\\""\nC="back\\\\slash"\nD="C:\\temp\\$HOME \\x"'),
    ).toEqual({
      A: "a\nb\tc\rd",
      B: 'say "hi"',
      C: "back\\slash",
      D: "C:\temp\\$HOME \\x",
    });
  });

  test("nothing is expanded", () => {
    expect(values("A=${B}\nB=\"$C ${D:-x} $$\"\nC='${E}'")).toEqual({
      A: "${B}",
      B: "$C ${D:-x} $$",
      C: "${E}",
    });
  });

  test("a quoted value may run over several lines, and the lines it holds are not read", () => {
    const pem = "-----BEGIN KEY-----\nMIIB\n# not a comment\nB=nope\n-----END KEY-----";
    const text = `K="${pem}"\nAFTER=1\nS='one\ntwo'\r\nCRLF="x\r\ny"`;
    expect(values(text)).toEqual({ K: pem, AFTER: "1", S: "one\ntwo", CRLF: "x\ny" });
    expect(issues(text)).toEqual([]);
  });

  test("an unclosed quote is reported at its line and the next lines are still read", () => {
    const text = 'A="never closed\nB=2\nC=3';
    expect(values(text)).toEqual({ B: "2", C: "3" });
    expect(issues(text)).toEqual(["unclosed_quote@1"]);
    expect(issues("A='x")).toEqual(["unclosed_quote@1"]);
  });

  test("text after a closing quote is a syntax issue at the line the value began", () => {
    const text = 'A="x" y\nB="m\nn" tail\nC=3';
    expect(values(text)).toEqual({ C: "3" });
    expect(issues(text)).toEqual(["syntax@1", "syntax@2"]);
  });

  test("lines that are not assignments, and keys that are not variable keys", () => {
    const text = [
      "just words",
      "=novalue",
      "A B=1",
      "my-key=1",
      "1ST=1",
      "ünï=1",
      "OK=1",
      "A.B=1",
    ].join("\n");
    expect(values(text)).toEqual({ OK: "1" });
    expect(issues(text)).toEqual([
      "syntax@1",
      "syntax@2",
      "syntax@3",
      "bad_key@4",
      "bad_key@5",
      "bad_key@6",
      "bad_key@8",
    ]);
  });

  test("a repeated key keeps the last value and says which line it replaced", () => {
    const text = "A=1\nB=2\nA=3\nA=4";
    expect(values(text)).toEqual({ A: "4", B: "2" });
    expect(issues(text)).toEqual(["duplicate@1:A", "duplicate@3:A"]);
  });

  test("a replaced multi-line value is named by the line it began on", () => {
    const text = 'A="one\ntwo"\nB=2\nA=3';
    expect(values(text)).toEqual({ A: "3", B: "2" });
    expect(issues(text)).toEqual(["duplicate@1:A"]);
  });

  test("keys keep the order of their first appearance and prototype names are plain keys", () => {
    const parsed = parseDotenv("B=1\n__proto__=2\nA=3\nconstructor=4");
    expect(parsed.entries.map((e) => e.key)).toEqual(["B", "__proto__", "A", "constructor"]);
  });

  test("a report names lines and valid keys, and never a piece of the file", () => {
    const text = [
      "SECRETWORD-1 no equals sign",
      "bad-key=SECRETWORD-2",
      "OPEN='SECRETWORD-3",
      'TAIL="x" SECRETWORD-4',
      "DUP=SECRETWORD-5",
      "DUP=SECRETWORD-6",
    ].join("\n");
    const out = JSON.stringify(parseDotenv(text).issues);
    expect(out).not.toContain("SECRETWORD");
    expect(parseDotenv(text).issues).toHaveLength(5);
  });

  test("an empty or comment-only file has nothing in it", () => {
    expect(parseDotenv("")).toEqual({ entries: [], issues: [] });
    expect(parseDotenv("# nothing\n\n   \n")).toEqual({ entries: [], issues: [] });
  });
});

describe("parseJsonVariables", () => {
  const parse = (x: unknown) => parseJsonVariables(typeof x === "string" ? x : JSON.stringify(x));
  const pairs = (x: unknown) => parse(x).entries.map((e) => `${e.key}=${e.value}`);

  test("an object of strings, and numbers and booleans as text", () => {
    expect(pairs({ A: "1", B: 2, C: true, D: false, E: 1.5, F: "" })).toEqual([
      "A=1",
      "B=2",
      "C=true",
      "D=false",
      "E=1.5",
      "F=",
    ]);
  });

  test("a list of {key, value}, so GitLab's own export reads, other fields ignored", () => {
    const list = [
      { key: "A", value: "1", variable_type: "env_var", masked: true, protected: false },
      { key: "B", value: "2", environment_scope: "*" },
    ];
    expect(pairs(list)).toEqual(["A=1", "B=2"]);
    expect(parse(list).issues).toEqual([]);
  });

  test("values that are not text, keys that are not keys, items that are not entries", () => {
    const out = parse({ A: null, B: { x: 1 }, C: [1], "bad-key": "x", OK: "1" });
    expect(out.entries).toEqual([{ key: "OK", value: "1" }]);
    expect(out.issues).toEqual([
      { reason: "bad_value", key: "A" },
      { reason: "bad_value", key: "B" },
      { reason: "bad_value", key: "C" },
      { reason: "bad_key" },
    ]);
    const list = parse([
      { key: "A" },
      "text",
      null,
      { value: "orphan" },
      { key: 5, value: "x" },
      { key: "B", value: "1" },
    ]);
    expect(list.entries).toEqual([{ key: "B", value: "1" }]);
    expect(list.issues).toEqual([
      { reason: "syntax" },
      { reason: "syntax" },
      { reason: "syntax" },
      { reason: "syntax" },
      { reason: "bad_key" },
    ]);
  });

  test("a repeated key in a list keeps the last", () => {
    const out = parse([
      { key: "A", value: "1" },
      { key: "A", value: "2" },
    ]);
    expect(out.entries).toEqual([{ key: "A", value: "2" }]);
    expect(out.issues).toEqual([{ reason: "duplicate", key: "A" }]);
  });

  test("a document that is not JSON, or not an object or list, is one issue and echoes nothing", () => {
    for (const bad of ['{"A": "SECRETWORD"', "SECRETWORD", '"SECRETWORD"', "42", "null", ""]) {
      const out = parse(bad);
      expect([bad, out.entries, out.issues]).toEqual([bad, [], [{ reason: "syntax" }]]);
      expect(JSON.stringify(out)).not.toContain("SECRETWORD");
    }
  });

  test("prototype names are plain keys", () => {
    expect(pairs('{"__proto__": "x", "constructor": "y"}')).toEqual([
      "__proto__=x",
      "constructor=y",
    ]);
  });
});
