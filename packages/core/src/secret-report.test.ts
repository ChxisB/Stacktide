import { describe, expect, test } from "bun:test";
import { MAX_REPORT_BYTES, MAX_REPORT_FINDINGS, parseSecretReport } from "./secret-report";

/** What a planted secret looks like: if it is anywhere in a result, a field was copied that must not be. */
const SECRET = "AKIAIOSFODNN7CANARY0";
const SHA = "a".repeat(40);

const finding = (over: Record<string, unknown> = {}) => ({
  id: "6f1c3e0a-0000-4000-8000-000000000001",
  category: "secret_detection",
  name: "AWS API key",
  message: `AWS API key ${SECRET}`,
  description: `Found ${SECRET}`,
  solution: `Revoke ${SECRET}`,
  cve: `config/aws.yml:${SECRET}`,
  severity: "Critical",
  raw_source_code_extract: `aws_key = ${SECRET}`,
  scanner: { id: "gitleaks", name: "Gitleaks" },
  location: {
    file: "config/aws.yml",
    start_line: 12,
    end_line: 12,
    commit: { sha: SHA, message: `add ${SECRET}`, author: SECRET, date: "2026-01-01T00:00:00Z" },
  },
  identifiers: [
    {
      type: "gitleaks_rule_id",
      name: "Gitleaks rule ID aws-access-token",
      value: "aws-access-token",
    },
    { type: "other", name: SECRET, value: SECRET },
  ],
  details: { snippet: { type: "code", value: SECRET } },
  tracking: { type: "source", items: [{ signatures: [{ algorithm: "hash", value: SECRET }] }] },
  links: [{ url: `https://example.test/${SECRET}` }],
  flags: [{ type: "flagged-as-likely-false-positive", origin: SECRET, description: SECRET }],
  [`unknown_${SECRET}`]: SECRET,
  ...over,
});

const report = (vulnerabilities: unknown[], scan: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: "15.1.0",
    scan: { status: "success", type: "secret_detection", ...scan },
    vulnerabilities,
  });

const ok = (text: string) => {
  const r = parseSecretReport(text);
  if (!r.ok) throw new Error(`expected a report, got ${r.reason}`);
  return r;
};

describe("what is copied out of a report", () => {
  test("only the rule, path, line, commit, severity and GitLab's id", () => {
    const r = ok(report([finding()]));
    expect(r.complete).toBe(true);
    expect(r.findings).toEqual([
      {
        fingerprint: "6f1c3e0a-0000-4000-8000-000000000001",
        rule: "aws-access-token",
        path: "config/aws.yml",
        line: 12,
        commit: SHA,
        severity: "critical",
      },
    ]);
  });

  test("a planted secret in any other field, listed or unknown, is nowhere in the result", () => {
    const r = ok(report([finding(), finding({ id: "second" })]));
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("CANARY");
    // and a secret planted in the fields it does read is not copied either when it is not of their shape
    const sneaky = ok(
      report([
        finding({
          severity: SECRET,
          location: { file: "a.yml", start_line: SECRET, commit: { sha: SECRET } },
          identifiers: [{ type: "gitleaks_rule_id", value: SECRET }],
        }),
      ]),
    );
    expect(JSON.stringify(sneaky)).not.toContain(SECRET);
  });

  test("a finding has exactly the allowlisted keys", () => {
    const text = report([finding()]);
    expect(Object.keys(ok(text).findings[0] ?? {}).sort()).toEqual([
      "commit",
      "fingerprint",
      "line",
      "path",
      "rule",
      "severity",
    ]);
  });

  test("the rule falls back to the first identifier, and an odd one reads as unknown", () => {
    const first = finding({ identifiers: [{ type: "x", name: "n", value: "generic-api-key" }] });
    expect(ok(report([first])).findings[0]?.rule).toBe("generic-api-key");
    const odd = finding({
      identifiers: [{ type: "x", name: "n", value: "has space and \n newline" }],
    });
    expect(ok(report([odd])).findings[0]?.rule).toBe("unknown");
  });

  test("severity is one of GitLab's words, lower-cased; any other word or none is unknown; the line may be missing", () => {
    const sev = (severity: unknown) => ok(report([finding({ severity })])).findings[0]?.severity;
    expect(sev("High")).toBe("high");
    expect(sev("Info")).toBe("info");
    expect(sev("Nonsense")).toBe("unknown");
    expect(sev(undefined)).toBe("unknown");
    const noLine = finding({ location: { file: "a", commit: { sha: SHA } } });
    expect(ok(report([noLine])).findings[0]?.line).toBeNull();
  });

  test("a line the column cannot hold is no line: the finding is kept, so one entry cannot fail the whole report", () => {
    const at = (start_line: number) =>
      ok(report([finding({ location: { file: "a", start_line, commit: { sha: SHA } } })]))
        .findings[0]?.line;
    expect(at(2_147_483_647)).toBe(2_147_483_647);
    expect(at(2_147_483_648)).toBeNull();
    expect(at(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  test("an entry that lacks an id, a path or a commit is skipped and counted, the rest are kept", () => {
    const r = ok(
      report([
        finding({ id: "keep-1" }),
        finding({ id: undefined }),
        finding({ id: "no-file", location: { commit: { sha: SHA } } }),
        finding({ id: "no-commit", location: { file: "a" } }),
        finding({ id: "bad sha", location: { file: "a", commit: { sha: "xyz" } } }),
        "not an object",
        null,
      ]),
    );
    expect(r.findings.map((f) => f.fingerprint)).toEqual(["keep-1"]);
    expect(r.skipped).toBe(6);
  });

  test("the same GitLab id twice is one finding", () => {
    const r = ok(report([finding({ id: "same" }), finding({ id: "same" })]));
    expect(r.findings).toHaveLength(1);
  });
});

describe("whether a report may say that a finding is gone", () => {
  test("a report of a scan that failed, or of part of the repository, is not complete", () => {
    expect(ok(report([], { status: "failure" })).complete).toBe(false);
    expect(ok(report([], { partial_scan: { mode: "differential" } })).complete).toBe(false);
    expect(ok(report([], {})).complete).toBe(true);
  });

  test("a report with no scan block is not complete", () => {
    expect(ok(JSON.stringify({ version: "15.1.0", vulnerabilities: [] })).complete).toBe(false);
  });
});

describe("what is refused, with a reason and without throwing", () => {
  test("malformed, wrong shape, too large, too many", () => {
    const reason = (text: string) => {
      const r = parseSecretReport(text);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason("")).toBe("malformed");
    expect(reason("{not json")).toBe("malformed");
    expect(reason("[]")).toBe("malformed");
    expect(reason("null")).toBe("malformed");
    expect(reason(JSON.stringify({ version: "1" }))).toBe("malformed");
    expect(reason(JSON.stringify({ vulnerabilities: "x" }))).toBe("malformed");
    expect(reason("x".repeat(MAX_REPORT_BYTES + 1))).toBe("too_large");
    const many = Array.from({ length: MAX_REPORT_FINDINGS + 1 }, (_, i) => ({ id: `f${i}` }));
    expect(reason(report(many))).toBe("too_many");
  });

  test("a refusal never carries the report's text", () => {
    const r = parseSecretReport(`{"secret": "${SECRET}" oops`);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
